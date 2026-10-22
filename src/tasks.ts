/**
 * Derive a plan from the focused goal's task list.
 *
 * This is the "always delegate" path: the main session does not need to invent
 * a DAG for a goal that pi-goal-x already decomposed. Each pending task becomes
 * one audited node; tasks run in document order (a sequential chain) and a final
 * verification node covers the integration. A goal without tasks becomes a
 * single objective node.
 *
 * Pure: it only maps data, so it is safe to call from the tool and from the
 * automatic trigger.
 */

import type { FocusedGoal } from "./goal.ts";
import type { PlanNodeSpec } from "./types.ts";

const DONE = new Set(["complete", "completed", "done", "skipped"]);

function nodeId(taskId: string, index: number): string {
	const clean = taskId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 48);
	return `task-${clean || index + 1}`;
}

function taskBrief(goal: FocusedGoal, task: { id: string; title: string }): string {
	return [
		`Goal: ${goal.objective}`,
		"",
		`Your assignment is one task from this goal's plan: "${task.title}" (task ${task.id}).`,
		"Work directly in the repository. Complete this task end to end:",
		"- Inspect the relevant code before changing it.",
		"- Make the change and run the focused tests or checks that prove it works.",
		"- Do not start work that belongs to other tasks of the goal.",
		"",
		"Return a short structured summary: what changed (files), the exact command(s) you ran,",
		"the observed result, and anything the next task must know. If you could not finish,",
		"say exactly what is blocking and what you tried.",
	].join("\n");
}

function objectiveBrief(goal: FocusedGoal): string {
	return [
		`Goal: ${goal.objective}`,
		"",
		"This goal has no task breakdown yet, so you own it end to end. Inspect the repository,",
		"implement the objective completely, run the relevant tests, and report what changed,",
		"the commands you ran, and the observed result. If the objective is ambiguous, implement",
		"the smallest coherent interpretation and state the assumption explicitly.",
	].join("\n");
}

function verifyBrief(goal: FocusedGoal, titles: string[]): string {
	return [
		`Goal: ${goal.objective}`,
		"",
		"This is the integrated verification node. The following tasks were implemented:",
		...titles.map((title) => `- ${title}`),
		"",
		"Verify the goal end to end on the real repository state: build, run the test suite or the",
		"end-to-end flow, and check that the objective is actually satisfied (not just that the files",
		"exist). Fix integration defects you can fix, then report the exact commands, their output,",
		"and any remaining gap with a clear verdict.",
	].join("\n");
}

/** One audited node per pending task, chained in order, plus integrated verification. */
export function nodesFromGoalTasks(goal: FocusedGoal): PlanNodeSpec[] {
	const pending = goal.tasks.filter((task) => !DONE.has(task.status.toLowerCase()));
	const nodes: PlanNodeSpec[] = [];
	let previous: string | undefined;
	pending.forEach((task, index) => {
		const id = nodeId(task.id, index);
		if (nodes.some((node) => node.id === id)) return;
		nodes.push({
			id,
			title: task.title.slice(0, 200),
			deps: previous ? [previous] : undefined,
			prompt: taskBrief(goal, task),
			audit: true,
		});
		previous = id;
	});

	if (nodes.length === 0) {
		return [
			{
				id: "goal",
				title: goal.objective.slice(0, 120) || "Goal",
				prompt: objectiveBrief(goal),
				audit: true,
			},
		];
	}

	nodes.push({
		id: "verify",
		title: "Integrated verification",
		deps: [previous as string],
		prompt: verifyBrief(goal, nodes.map((node) => node.title ?? node.id)),
		audit: true,
	});
	return nodes;
}
