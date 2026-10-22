/**
 * Best-effort reader for the focused pi-goal.
 *
 * Goals live in `.pi/goals/active_goal_*.md` (a JSON header followed by the
 * user-editable goal prompt) and focus is a session-scoped entry written by
 * pi-goal-x. Reading both lets callers omit the objective when they are already
 * inside a focused goal. No goal state is ever written here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface FocusedGoal {
	id: string;
	objective: string;
	status?: string;
	sisyphus?: boolean;
	/** pi-goal-x execution preference; false means no autonomous continuation. */
	autoContinue?: boolean;
	path: string;
	/** Pending tasks from the goal file, when present. */
	tasks: Array<{ id: string; title: string; status: string }>;
}

interface FocusEntryData {
	version?: number;
	focusedGoalId?: string | null;
}

interface GoalHeader {
	id?: string;
	objective?: string;
	status?: string;
	sisyphus?: boolean;
	autoContinue?: boolean;
	taskList?: {
		tasks?: Array<{
			id?: string;
			title?: string;
			status?: string;
			subtasks?: unknown;
		}>;
	};
}

function goalsDir(cwd: string): string {
	return path.join(cwd, ".pi", "goals");
}

/** Parse the leading JSON object of an active goal file. */
export function parseGoalHeader(text: string): GoalHeader | null {
	if (!text.startsWith("{")) return null;
	const marker = text.indexOf("\n\n#");
	const end = marker >= 0 ? marker : text.length;
	try {
		const parsed = JSON.parse(text.slice(0, end).trim()) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as GoalHeader) : null;
	} catch {
		return null;
	}
}

function flattenTasks(tasks: GoalHeader["taskList"] extends { tasks?: infer T } ? T : never, out: FocusedGoal["tasks"], depth = 0): void {
	if (!Array.isArray(tasks) || depth > 6) return;
	for (const task of tasks as Array<Record<string, unknown>>) {
		if (typeof task.id !== "string" || typeof task.title !== "string") continue;
		out.push({ id: task.id, title: task.title, status: typeof task.status === "string" ? task.status : "pending" });
		flattenTasks(task.subtasks as never, out, depth + 1);
	}
}

function readGoalFile(filePath: string): GoalHeader | null {
	try {
		return parseGoalHeader(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

/** Last focus entry in the current branch, if any. */
export function focusedGoalIdFromBranch(entries: readonly unknown[]): string | null {
	let focused: string | null = null;
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== "pi-goal-focus") continue;
		const data = entry.data as FocusEntryData | undefined;
		focused = typeof data?.focusedGoalId === "string" ? data.focusedGoalId : null;
	}
	return focused;
}

/**
 * Locate the focused goal. Returns null when the session has no focus entry,
 * the goal file is gone, or the header cannot be parsed.
 */
export function readFocusedGoal(ctx: ExtensionContext): FocusedGoal | null {
	if (process.env.PI_SUBAGENT_CHILD === "1") return null;
	let entries: unknown[] = [];
	try {
		entries = ctx.sessionManager.getBranch() as unknown[];
	} catch {
		return null;
	}
	const focusedId = focusedGoalIdFromBranch(entries);
	if (!focusedId) return null;

	const root = goalsDir(ctx.cwd);
	let candidates: string[] = [];
	try {
		candidates = fs.readdirSync(root)
			.filter((name) => name.startsWith("active_goal_") && name.endsWith(".md"))
			.sort()
			.reverse();
	} catch {
		return null;
	}

	for (const name of candidates) {
		const filePath = path.join(root, name);
		const header = readGoalFile(filePath);
		if (header?.id !== focusedId) continue;
		const tasks: FocusedGoal["tasks"] = [];
		flattenTasks(header.taskList?.tasks as never, tasks);
		return {
			id: focusedId,
			objective: typeof header.objective === "string" ? header.objective : "",
			status: header.status,
			sisyphus: header.sisyphus,
			autoContinue: typeof header.autoContinue === "boolean" ? header.autoContinue : undefined,
			path: filePath,
			tasks,
		};
	}
	return null;
}

/** Read a goal header by id, used by the status command. */
export function readGoalById(cwd: string, id: string): FocusedGoal | null {
	const root = goalsDir(cwd);
	let names: string[] = [];
	try {
		names = fs.readdirSync(root).filter((name) => name.startsWith("active_goal_") && name.endsWith(".md"));
	} catch {
		return null;
	}
	for (const name of names) {
		const filePath = path.join(root, name);
		const header = readGoalFile(filePath);
		if (header?.id !== id) continue;
		const tasks: FocusedGoal["tasks"] = [];
		flattenTasks(header.taskList?.tasks as never, tasks);
		return {
			id,
			objective: typeof header.objective === "string" ? header.objective : "",
			status: header.status,
			sisyphus: header.sisyphus,
			autoContinue: typeof header.autoContinue === "boolean" ? header.autoContinue : undefined,
			path: filePath,
			tasks,
		};
	}
	return null;
}
