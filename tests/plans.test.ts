import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	formatPlanList,
	nextPlanNumber,
	PlanStore,
	planSummaryLine,
	renderPlanMarkdown,
	resolveResumeTarget,
	type PlanRecord,
} from "../src/plans.ts";
import type { PlanNodeSpec } from "../src/types.ts";

const NODES: PlanNodeSpec[] = [
	{ id: "contract", title: "Contract", prompt: "Define the contract", deps: [] },
	{ id: "impl", title: "Implement", prompt: "Implement it", deps: ["contract"] },
];

function plan(number: number, overrides: Partial<PlanRecord> = {}): PlanRecord {
	return {
		number,
		title: `Plan ${number}`,
		objective: `Objective ${number}`,
		requirements: [],
		status: "planned",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		nodes: NODES,
		...overrides,
	};
}

test("plan numbers continue from the highest existing plan", () => {
	assert.equal(nextPlanNumber([]), 1);
	assert.equal(nextPlanNumber([1, 2, 3]), 4);
	assert.equal(nextPlanNumber([2, 7, 4]), 8);
	assert.equal(nextPlanNumber([0, -1]), 1);
});

test("summary and list formats expose number, title and status", () => {
	assert.match(planSummaryLine(plan(3)), /^#3 · Plan 3 · planned · 2 nodes$/);
	assert.match(formatPlanList([]), /No plans yet/);
	const list = formatPlanList([plan(1), plan(2, { status: "running" })]);
	assert.match(list, /#1 · Plan 1 · planned/);
	assert.match(list, /#2 · Plan 2 · running/);
	assert.match(list, /Running now: #2/);
});

test("resume target: explicit number, newest resumable, or a clear error", () => {
	assert.match(resolveResumeTarget([], "").error ?? "", /No plans yet/);
	assert.match(resolveResumeTarget([plan(1)], "abc").error ?? "", /not a plan number/);
	assert.match(resolveResumeTarget([plan(1)], "9").error ?? "", /not found/);
	assert.equal(resolveResumeTarget([plan(1), plan(2)], "1").plan?.number, 1);

	const mixed = [plan(1, { status: "complete" }), plan(2, { status: "planned" }), plan(3, { status: "complete" })];
	assert.equal(resolveResumeTarget(mixed, "").plan?.number, 2);
	const allComplete = [plan(1, { status: "complete" }), plan(4, { status: "complete" })];
	assert.equal(resolveResumeTarget(allComplete, "").plan?.number, 4);
	const running = [plan(1), plan(5, { status: "running" })];
	assert.equal(resolveResumeTarget(running, "").plan?.number, 1);
	assert.equal(resolveResumeTarget(running, "5").plan?.number, 5);
});

test("last run node outcomes are rendered and persisted", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-plans-last-"));
	try {
		const store = new PlanStore(cwd, ".pi/orchestrator");
		const saved = store.create({ title: "Run", objective: "Run it", nodes: NODES });
		store.update(saved.number, {
			status: "complete",
			lastNodes: [
				{ id: "contract", status: "done", attempts: 1 },
				{ id: "impl", status: "failed", attempts: 2 },
			],
		});
		const loaded = store.get(saved.number);
		assert.equal(loaded?.status, "complete");
		assert.deepEqual(loaded?.lastNodes?.map((node) => node.status), ["done", "failed"]);
		const markdown = renderPlanMarkdown(loaded!);
		assert.match(markdown, /## Last run/);
		assert.match(markdown, /\[done\] contract/);
		assert.match(markdown, /\[failed\] impl \(attempts 2\)/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("rendered markdown contains the objective, requirements and nodes", () => {
	const markdown = renderPlanMarkdown(
		plan(7, { requirements: ["must be fast", "must be safe"], notes: "assume Postgres", description: "raw draft" }),
	);
	assert.match(markdown, /# Plan #7 — Plan 7/);
	assert.match(markdown, /## Objective/);
	assert.match(markdown, /must be fast/);
	assert.match(markdown, /assume Postgres/);
	assert.match(markdown, /raw draft/);
	assert.match(markdown, /### contract — Contract/);
	assert.match(markdown, /Deps: contract/);
});

test("clearAll removes every plan but leaves run artifacts alone", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-clear-"));
	try {
		const store = new PlanStore(cwd, ".pi/orchestrator");
		store.create({ title: "One", objective: "One", nodes: NODES });
		store.create({ title: "Two", objective: "Two", nodes: NODES });
		const runDir = path.join(cwd, ".pi", "orchestrator", "runs", "run-1");
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(path.join(runDir, "run.json"), "{}");

		assert.equal(store.clearAll(), 2);
		assert.deepEqual(store.list(), []);
		assert.equal(fs.existsSync(store.root), false);
		assert.equal(fs.existsSync(path.join(runDir, "run.json")), true);
		assert.equal(store.clearAll(), 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("PlanStore numbers, persists, reads and updates plans", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-plans-"));
	try {
		const store = new PlanStore(cwd, ".pi/orchestrator");
		assert.deepEqual(store.list(), []);
		assert.equal(store.nextNumber(), 1);

		const first = store.create({ title: "First", objective: "Do first", nodes: NODES });
		assert.equal(first.number, 1);
		const second = store.create({ title: "Second", objective: "Do second", nodes: NODES });
		assert.equal(second.number, 2);

		assert.deepEqual(
			store.list().map((entry) => entry.number),
			[1, 2],
		);
		assert.ok(fs.existsSync(path.join(store.dir(1), "plan.json")));
		assert.ok(fs.existsSync(path.join(store.dir(1), "plan.md")));
		assert.equal(store.get(2)?.title, "Second");

		const updated = store.update(1, { status: "complete", runId: "run-1", runStatus: "complete" });
		assert.equal(updated?.status, "complete");
		assert.equal(store.get(1)?.runId, "run-1");

		// A malformed plan directory is ignored, not fatal.
		fs.mkdirSync(path.join(store.root, "9"), { recursive: true });
		fs.writeFileSync(path.join(store.root, "9", "plan.json"), "{broken");
		assert.deepEqual(
			store.list().map((entry) => entry.number),
			[1, 2],
		);
		assert.equal(store.nextNumber(), 3);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
