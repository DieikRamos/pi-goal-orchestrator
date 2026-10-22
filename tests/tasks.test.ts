import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePlan } from "../src/dag.ts";
import type { FocusedGoal } from "../src/goal.ts";
import { nodesFromGoalTasks } from "../src/tasks.ts";

function goal(overrides: Partial<FocusedGoal> = {}): FocusedGoal {
	return {
		id: "g1",
		objective: "Add CSV export to the report screen",
		status: "active",
		path: "/tmp/goal.md",
		tasks: [],
		...overrides,
	};
}

test("one audited node per pending task, chained in order, plus verification", () => {
	const nodes = nodesFromGoalTasks(
		goal({
			tasks: [
				{ id: "1", title: "Contract", status: "pending" },
				{ id: "2", title: "Backend", status: "in_progress" },
				{ id: "3", title: "Frontend", status: "complete" },
				{ id: "4", title: "Docs", status: "skipped" },
			],
		}),
	);
	assert.deepEqual(
		nodes.map((node) => node.id),
		["task-1", "task-2", "verify"],
	);
	assert.deepEqual(nodes[0]?.deps, undefined);
	assert.deepEqual(nodes[1]?.deps, ["task-1"]);
	assert.deepEqual(nodes[2]?.deps, ["task-2"]);
	assert.equal(nodes.every((node) => node.audit === true), true);
	assert.ok(nodes[0]?.prompt.includes("Add CSV export"));
	assert.ok(nodes[0]?.prompt.includes("Contract"));
	assert.ok(nodes[2]?.prompt.includes("Integrated verification") === false);
	assert.ok(nodes[2]?.prompt.includes("end to end"));
});

test("a goal without pending tasks becomes a single objective node", () => {
	const nodes = nodesFromGoalTasks(goal({ tasks: [{ id: "1", title: "Done", status: "complete" }] }));
	assert.equal(nodes.length, 1);
	assert.equal(nodes[0]?.id, "goal");
	assert.ok(nodes[0]?.prompt.includes("Add CSV export"));
});

test("derived nodes pass plan validation with defaults", () => {
	const nodes = nodesFromGoalTasks(
		goal({
			tasks: [
				{ id: "1.1", title: "Spike", status: "pending" },
				{ id: "a b/c", title: "Weird id", status: "pending" },
			],
		}),
	);
	const plan = normalizePlan({ goal_id: "g1", objective: "x", nodes });
	assert.deepEqual(
		plan.nodes.map((node) => node.id),
		["task-1.1", "task-a-b-c", "verify"],
	);
	assert.equal(plan.maxConcurrent, 3);
});
