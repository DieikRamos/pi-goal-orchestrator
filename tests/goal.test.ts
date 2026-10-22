import assert from "node:assert/strict";
import { test } from "node:test";
import { focusedGoalIdFromBranch, parseGoalHeader } from "../src/goal.ts";

const FILE = `{
  "version": 3,
  "id": "goal-1",
  "objective": "Add CSV export",
  "status": "active",
  "autoContinue": true,
  "taskList": {
    "tasks": [
      { "id": "t1", "title": "Contract", "status": "complete", "subtasks": [{ "id": "t1.1", "title": "Types", "status": "pending" }] }
    ]
  }
}

# Goal Prompt

Add CSV export
`;

test("parses the JSON header before the goal prompt", () => {
	const header = parseGoalHeader(FILE);
	assert.equal(header?.id, "goal-1");
	assert.equal(header?.objective, "Add CSV export");
	assert.equal(header?.status, "active");
	assert.equal(header?.autoContinue, true);
	assert.equal(header?.taskList?.tasks?.[0]?.id, "t1");
});

test("returns null for malformed files", () => {
	assert.equal(parseGoalHeader("not json"), null);
	assert.equal(parseGoalHeader("{broken}"), null);
});

test("last focus entry wins", () => {
	const entries = [
		{ type: "custom", customType: "pi-goal-focus", data: { focusedGoalId: "a" } },
		{ type: "message", role: "user" },
		{ type: "custom", customType: "pi-goal-focus", data: { focusedGoalId: "b" } },
		{ type: "custom", customType: "pi-goal-focus", data: { focusedGoalId: null } },
	];
	assert.equal(focusedGoalIdFromBranch(entries), null);
	assert.equal(focusedGoalIdFromBranch(entries.slice(0, 3)), "b");
	assert.equal(focusedGoalIdFromBranch([]), null);
});
