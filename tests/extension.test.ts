import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import goalOrchestrator from "../extensions/orchestrator.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Harness {
	tools: Map<string, unknown>;
	handlers: Map<string, Handler>;
	commands: Map<string, unknown>;
	sent: unknown[];
}

function harness(): Harness {
	const tools = new Map<string, unknown>();
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, unknown>();
	const sent: unknown[] = [];
	const pi = {
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		sendMessage: (message: unknown) => sent.push(message),
		events: { on: () => () => {}, emit: () => {}, off: () => {} },
	};
	goalOrchestrator(pi as never);
	return { tools, handlers, commands, sent };
}

function project(objective: string, autoContinue = true): { cwd: string; ctx: unknown } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-ext-"));
	fs.mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
	const header = {
		version: 3,
		id: "g1",
		objective,
		status: "active",
		autoContinue,
		taskList: { blockCompletion: false, tasks: [{ id: "1", title: "Contract", status: "pending" }] },
	};
	fs.writeFileSync(
		path.join(cwd, ".pi", "goals", "active_goal_g1.md"),
		`${JSON.stringify(header, null, 2)}\n\n# Goal Prompt\n\n${objective}\n`,
	);
	const ctx = {
		cwd,
		sessionManager: {
			getBranch: () => [{ type: "custom", customType: "pi-goal-focus", data: { focusedGoalId: "g1" } }],
		},
		ui: { notify: () => {} },
	};
	return { cwd, ctx };
}

test("registers the tool, the commands and the automatic hooks", () => {
	const h = harness();
	assert.ok(h.tools.has("run_goal_plan"));
	assert.ok(h.commands.has("orchestrate"));
	assert.ok(h.commands.has("orchestrate-status"));
	assert.ok(h.commands.has("orchestrate-settings"));
	assert.ok(h.handlers.has("before_agent_start"));
	assert.ok(h.handlers.has("tool_call"));
	assert.ok(h.handlers.has("agent_before_settle"));
});

test("a decided goal is continued once with the hidden planning message", () => {
	const h = harness();
	const { cwd, ctx } = project("Add CSV export");
	try {
		const settle = h.handlers.get("agent_before_settle") as Handler;
		const event = { outcome: "completed", continue: false, context: { pendingMessages: [] } };
		const first = settle(event, ctx) as { continue?: boolean; entries?: Array<{ customType: string }> };
		assert.equal(first?.continue, true);
		assert.equal(first?.entries?.[0]?.customType, "pi-goal-orchestrator:auto");
		assert.ok(fs.existsSync(path.join(cwd, ".pi", "goals", "orchestrator", "auto", "g1.json")));

		const second = settle(event, ctx);
		assert.equal(second, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("a goal that opted out of auto-continue is never nudged", () => {
	const h = harness();
	const { cwd, ctx } = project("Add CSV export", false);
	try {
		const settle = h.handlers.get("agent_before_settle") as Handler;
		const result = settle({ outcome: "completed", continue: false, context: { pendingMessages: [] } }, ctx);
		assert.equal(result, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("write/edit are blocked until the goal has a run, then allowed for fixes", () => {
	const h = harness();
	const { cwd, ctx } = project("Add CSV export");
	try {
		const guard = h.handlers.get("tool_call") as Handler;
		const blocked = guard({ toolName: "edit", args: {} }, ctx) as { block?: boolean; reason?: string };
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /run_goal_plan/);
		assert.equal(guard({ toolName: "bash", args: {} }, ctx), undefined);

		const runs = path.join(cwd, ".pi", "goals", "orchestrator", "runs", "r1");
		fs.mkdirSync(runs, { recursive: true });
		fs.writeFileSync(
			path.join(runs, "run.json"),
			JSON.stringify({ runId: "r1", goalId: "g1", objective: "Add CSV export", status: "complete" }),
		);
		assert.equal(guard({ toolName: "edit", args: {} }, ctx), undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
