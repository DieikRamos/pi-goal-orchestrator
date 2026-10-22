import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	autoMarkerPath,
	autoStartMessage,
	decideAutoStart,
	listRuns,
	objectiveSignature,
	parseModeArgs,
	readAutoMarker,
	safeSegment,
	writeAutoMarker,
} from "../src/auto.ts";

const goal = { id: "goal-1", status: "active", objective: "Add CSV export" };

test("objective signatures ignore whitespace but not content", () => {
	assert.equal(objectiveSignature("  Add   CSV\nexport "), objectiveSignature("Add CSV export"));
	assert.notEqual(objectiveSignature("Add CSV export"), objectiveSignature("Add PDF export"));
});

test("newly decided active goal starts", () => {
	const decision = decideAutoStart({ goal, enabled: true, runs: [], marker: null, inFlight: false });
	assert.equal(decision.start, true);
	assert.equal(decision.signature, objectiveSignature(goal.objective));
});

test("disabled, unfocused, inactive, empty or in-flight goals do not start", () => {
	assert.equal(decideAutoStart({ goal, enabled: false, runs: [], marker: null, inFlight: false }).start, false);
	assert.equal(decideAutoStart({ goal: null, enabled: true, runs: [], marker: null, inFlight: false }).start, false);
	assert.equal(
		decideAutoStart({ goal: { ...goal, status: "paused" }, enabled: true, runs: [], marker: null, inFlight: false })
			.start,
		false,
	);
	assert.equal(
		decideAutoStart({ goal: { ...goal, objective: "  " }, enabled: true, runs: [], marker: null, inFlight: false })
			.start,
		false,
	);
	assert.equal(decideAutoStart({ goal, enabled: true, runs: [], marker: null, inFlight: true }).start, false);
});

test("force bypasses the run and marker guards but not an in-flight run", () => {
	assert.equal(
		decideAutoStart({
			goal,
			enabled: false,
			runs: [{ runId: "r1", goalId: goal.id, objective: goal.objective, status: "complete" }],
			marker: { goalId: goal.id, signature: objectiveSignature(goal.objective), triggeredAt: "t" },
			inFlight: false,
			force: true,
		}).start,
		true,
	);
	assert.equal(decideAutoStart({ goal, enabled: true, runs: [], marker: null, inFlight: true, force: true }).start, false);
});

test("a goal that opted out of autonomous continuation is not nudged", () => {
	const optedOut = decideAutoStart({
		goal: { ...goal, autoContinue: false },
		enabled: true,
		runs: [],
		marker: null,
		inFlight: false,
	});
	assert.equal(optedOut.start, false);
	assert.match(optedOut.reason, /opted out/);
	const forced = decideAutoStart({
		goal: { ...goal, autoContinue: false },
		enabled: true,
		runs: [],
		marker: null,
		inFlight: false,
		force: true,
	});
	assert.equal(forced.start, true);
});

test("an objective already run or already nudged is not repeated", () => {
	const signature = objectiveSignature(goal.objective);
	const ran = decideAutoStart({
		goal,
		enabled: true,
		runs: [{ runId: "r1", goalId: goal.id, objective: goal.objective, status: "failed" }],
		marker: null,
		inFlight: false,
	});
	assert.equal(ran.start, false);
	assert.match(ran.reason, /already orchestrated/);

	const nudged = decideAutoStart({
		goal,
		enabled: true,
		runs: [],
		marker: { goalId: goal.id, signature, triggeredAt: "t" },
		inFlight: false,
	});
	assert.equal(nudged.start, false);
	assert.match(nudged.reason, /already queued/);
});

test("a tweaked objective may be orchestrated again", () => {
	const decision = decideAutoStart({
		goal: { ...goal, objective: "Add PDF export" },
		enabled: true,
		runs: [{ runId: "r1", goalId: goal.id, objective: goal.objective, status: "complete" }],
		marker: { goalId: goal.id, signature: objectiveSignature(goal.objective), triggeredAt: "t" },
		inFlight: false,
	});
	assert.equal(decision.start, true);
});

test("the planning message is self-contained and points at run_goal_plan", () => {
	const message = autoStartMessage(goal, "newly decided goal");
	assert.match(message, /run_goal_plan/);
	assert.match(message, /"tasks": true/);
	assert.match(message, /Add CSV export/);
	assert.match(message, /goal-1/);
});

test("orchestrate-mode arguments parse scope and value", () => {
	assert.deepEqual(parseModeArgs(undefined), { scope: "all", value: "toggle" });
	assert.deepEqual(parseModeArgs("  "), { scope: "all", value: "toggle" });
	assert.deepEqual(parseModeArgs("off"), { scope: "all", value: "off" });
	assert.deepEqual(parseModeArgs("status"), { scope: "all", value: "status" });
	assert.deepEqual(parseModeArgs("auto"), { scope: "auto", value: "status" });
	assert.deepEqual(parseModeArgs("auto on"), { scope: "auto", value: "on" });
	assert.deepEqual(parseModeArgs("enforce toggle"), { scope: "enforce", value: "toggle" });
	assert.deepEqual(parseModeArgs("all off"), { scope: "all", value: "off" });
	assert.deepEqual(parseModeArgs("bogus"), { scope: "all", value: "invalid" });
	assert.deepEqual(parseModeArgs("auto later"), { scope: "auto", value: "invalid" });
});

test("marker paths stay inside the artifacts root", () => {
	const file = autoMarkerPath("/tmp/project", ".pi/goals/orchestrator", "../evil/goal id");
	assert.match(file, /^\/tmp\/project\/\.pi\/goals\/orchestrator\/auto\//);
	assert.doesNotMatch(file, /evil\/goal id/);
	assert.equal(safeSegment("a/b c", "x"), "a-b-c");
});

test("marker roundtrip and run discovery ignore malformed files", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-auto-"));
	try {
		const marker = {
			goalId: goal.id,
			signature: objectiveSignature(goal.objective),
			triggeredAt: "2026-01-01T00:00:00.000Z",
			reason: "test",
		};
		writeAutoMarker(cwd, ".pi/goals/orchestrator", marker);
		assert.deepEqual(readAutoMarker(cwd, ".pi/goals/orchestrator", goal.id), marker);

		const runs = path.join(cwd, ".pi/goals/orchestrator/runs");
		fs.mkdirSync(path.join(runs, "r1"), { recursive: true });
		fs.writeFileSync(
			path.join(runs, "r1", "run.json"),
			JSON.stringify({ runId: "r1", goalId: goal.id, objective: goal.objective, status: "complete" }),
		);
		fs.mkdirSync(path.join(runs, "broken"), { recursive: true });
		fs.writeFileSync(path.join(runs, "broken", "run.json"), "{not json");
		assert.deepEqual(listRuns(cwd, ".pi/goals/orchestrator"), [
			{ runId: "r1", goalId: goal.id, objective: goal.objective, status: "complete" },
		]);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
