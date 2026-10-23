import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import orchestrator from "../extensions/orchestrator.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Harness {
	tools: Map<string, { execute: (...args: unknown[]) => unknown }>;
	handlers: Map<string, Handler>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	sent: Array<{ customType: string; content: string }>;
	notices: string[];
	widgets: string[];
	statuses: Array<string | undefined>;
}

function harness(): Harness {
	const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const sent: Array<{ customType: string; content: string }> = [];
	const notices: string[] = [];
	const widgets: string[] = [];
	const statuses: Array<string | undefined> = [];
	const pi = {
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => unknown }) => tools.set(tool.name, tool),
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, command),
		sendMessage: (message: { customType: string; content: string }) => sent.push(message),
		events: { on: () => () => {}, emit: () => {}, off: () => {} },
	};
	orchestrator(pi as never);
	return { tools, handlers, commands, sent, notices, widgets, statuses };
}

interface TestCtx {
	cwd: string;
	ui: {
		notify: (message: string) => void;
		setWidget: (key: string, content: unknown) => void;
		setStatus: (key: string, text: string | undefined) => void;
		confirm: (title: string, message: string) => Promise<boolean>;
	};
	hasUI: boolean;
	sessionManager: { getBranch: () => unknown[] };
}

function tempCwd(h: Harness): TestCtx {
	return {
		cwd: fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-ext-")),
		ui: {
			notify: (message: string) => h.notices.push(message),
			setWidget: (key: string) => h.widgets.push(key),
			setStatus: (_key: string, text: string | undefined) => h.statuses.push(text),
			confirm: async () => true,
		},
		hasUI: true,
		sessionManager: { getBranch: () => [] },
	};
}

async function createPlan(
	tools: Harness["tools"],
	ctx: TestCtx,
	title = "CSV export",
	objective = "Add CSV export",
): Promise<{ text: string; number: number }> {
	const tool = tools.get("orchestrator_plan");
	assert.ok(tool);
	const result = (await tool.execute("call-1", { title, objective }, undefined, undefined, ctx)) as {
		content: Array<{ text: string }>;
		details: { planNumber: number };
	};
	return { text: result.content[0]!.text, number: result.details.planNumber };
}

test("registers the two tools, the commands and the session hooks", () => {
	const h = harness();
	assert.ok(h.tools.has("orchestrator_plan"));
	assert.ok(h.tools.has("orchestrator_run"));
	for (const command of [
		"orchestrator-plan",
		"orchestrator-plan-clear",
		"orchestrator-plan-list",
		"orchestrator-resume",
		"orchestrator-plan-list",
		"orchestrator-status",
		"orchestrator-settings",
	]) {
		assert.ok(h.commands.has(command), `missing /${command}`);
	}
	assert.ok(h.handlers.has("session_start"));
	assert.ok(h.handlers.has("session_shutdown"));
});

test("orchestrator_plan persists numbered plans and renders the widget", async () => {
	const h = harness();
	const ctx = tempCwd(h);
	try {
		const start = h.handlers.get("session_start");
		assert.ok(start);
		start({}, ctx);
		const first = await createPlan(h.tools, ctx, "CSV export", "Add CSV export to reports");
		assert.equal(first.number, 1);
		assert.match(first.text, /Plan #1 saved/);

		const second = await createPlan(h.tools, ctx, "PDF export", "Add PDF export");
		assert.equal(second.number, 2);

		const dir = path.join(ctx.cwd, ".pi", "orchestrator", "plans");
		assert.ok(fs.existsSync(path.join(dir, "1", "plan.json")));
		assert.ok(fs.existsSync(path.join(dir, "1", "plan.md")));
		const stored = JSON.parse(fs.readFileSync(path.join(dir, "2", "plan.json"), "utf8")) as {
			title: string;
			status: string;
			nodes: Array<{ id: string }>;
		};
		assert.equal(stored.title, "PDF export");
		assert.equal(stored.status, "planned");
		assert.deepEqual(stored.nodes.map((node) => node.id), ["goal"]);

		assert.ok(h.widgets.includes("orchestrator"));
		assert.ok(h.statuses.some((line) => line?.includes("2 plans")));
	} finally {
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	}
});

test("/orchestrator-plan starts a hidden planning turn with the draft", async () => {
	const h = harness();
	const ctx = tempCwd(h);
	try {
		const command = h.commands.get("orchestrator-plan");
		assert.ok(command);
		await command.handler("Add CSV export to the reports screen", ctx);
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0]?.customType, "pi-orchestrator-plan");
		assert.match(h.sent[0]?.content ?? "", /Add CSV export/);
		assert.match(h.sent[0]?.content ?? "", /orchestrator_plan/);
	} finally {
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	}
});

test("/orchestrator-resume resolves by number and refuses running plans", async () => {
	const h = harness();
	const ctx = tempCwd(h);
	try {
		const resume = h.commands.get("orchestrator-resume");
		assert.ok(resume);
		await resume.handler("", ctx);
		assert.match(h.notices.at(-1) ?? "", /No plans yet/);

		await createPlan(h.tools, ctx);
		await resume.handler("", ctx);
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0]?.customType, "pi-orchestrator-resume");
		assert.match(h.sent[0]?.content ?? "", /"plan_number": 1/);

		// A running plan is not resumed twice.
		const store = new (await import("../src/plans.ts")).PlanStore(ctx.cwd, ".pi/orchestrator");
		store.update(1, { status: "running" });
		await resume.handler("1", ctx);
		assert.match(h.notices.at(-1) ?? "", /already running/);
		assert.equal(h.sent.length, 1);

		await resume.handler("9", ctx);
		assert.match(h.notices.at(-1) ?? "", /not found/);
	} finally {
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	}
});

test("orchestrator_run rejects a missing plan before touching subagents", async () => {
	const h = harness();
	const ctx = tempCwd(h);
	try {
		const tool = h.tools.get("orchestrator_run");
		assert.ok(tool);
		const result = (await tool.execute("call-9", { plan_number: 99 }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
			isError: boolean;
		};
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Plan #99 not found/);
	} finally {
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	}
});

test("/orchestrator-plan-clear deletes all plans and keeps run artifacts", async () => {
	const h = harness();
	const ctx = tempCwd(h);
	try {
		await createPlan(h.tools, ctx, "One", "One");
		await createPlan(h.tools, ctx, "Two", "Two");
		const runDir = path.join(ctx.cwd, ".pi", "orchestrator", "runs", "run-1");
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(path.join(runDir, "run.json"), "{}");

		const clear = h.commands.get("orchestrator-plan-clear");
		assert.ok(clear);
		await clear.handler("--yes", ctx);
		assert.match(h.notices.at(-1) ?? "", /Cleared 2 plans/);
		assert.equal(fs.existsSync(path.join(ctx.cwd, ".pi", "orchestrator", "plans")), false);
		assert.equal(fs.existsSync(path.join(runDir, "run.json")), true);

		await clear.handler("", ctx);
		assert.match(h.notices.at(-1) ?? "", /No plans to clear/);
	} finally {
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	}
});

test("/orchestrator-plan-clear refuses without confirmation in a headless session", async () => {
	const h = harness();
	const ctx = tempCwd(h);
	try {
		await createPlan(h.tools, ctx, "Keep me", "Keep me");
		ctx.hasUI = false;
		const clear = h.commands.get("orchestrator-plan-clear");
		assert.ok(clear);
		await clear.handler("", ctx);
		assert.match(h.notices.at(-1) ?? "", /Refusing to delete 1 plan/);
		assert.ok(fs.existsSync(path.join(ctx.cwd, ".pi", "orchestrator", "plans", "1", "plan.json")));
	} finally {
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	}
});

test("/orchestrator-plan-list and /orchestrator-status report stored plans", async () => {
	const h = harness();
	const ctx = tempCwd(h);
	try {
		await createPlan(h.tools, ctx, "CSV export", "Add CSV export");
		const list = h.commands.get("orchestrator-plan-list");
		const status = h.commands.get("orchestrator-status");
		assert.ok(list && status);
		await list.handler("", ctx);
		assert.match(h.notices.at(-1) ?? "", /#1 · CSV export · planned/);
		await status.handler("1", ctx);
		assert.match(h.notices.at(-1) ?? "", /Plan #1 — CSV export/);
		assert.match(h.notices.at(-1) ?? "", /Objective: Add CSV export/);
	} finally {
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	}
});
