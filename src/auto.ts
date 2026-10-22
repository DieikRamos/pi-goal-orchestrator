/**
 * Automatic orchestration trigger.
 *
 * A goal is "decided" once pi-goal-x writes it as an active, focused goal. At
 * that point the orchestrator should not wait for the user to ask for a DAG:
 * the next turn is steered to call `run_goal_plan`, and if the model still does
 * the work inline, the settled boundary queues one planning message.
 *
 * Loop safety comes from two durable facts:
 * - a run for this goal already exists with the same objective signature;
 * - a planning message was already queued for this signature.
 *
 * A tweaked objective changes the signature and may legitimately be planned
 * again. A failed run is never retried automatically; use `/orchestrate`.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RunSummary {
	runId: string;
	goalId?: string;
	objective: string;
	status: string;
}

export interface AutoMarker {
	goalId: string;
	signature: string;
	triggeredAt: string;
	reason?: string;
}

export interface AutoStartInput {
	goal: { id: string; status?: string; objective: string; autoContinue?: boolean } | null;
	enabled: boolean;
	runs: RunSummary[];
	marker?: AutoMarker | null;
	/** A run_goal_plan call is currently executing in this session. */
	inFlight: boolean;
	/** `/orchestrate` bypasses the run and marker guards. */
	force?: boolean;
}

export interface AutoStartDecision {
	start: boolean;
	reason: string;
	signature: string;
}

export function safeSegment(value: string, fallback: string): string {
	const clean = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
	return clean || fallback;
}

/** Stable fingerprint of an objective; whitespace changes do not re-trigger. */
export function objectiveSignature(objective: string): string {
	return createHash("sha1").update(objective.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 16);
}

export function decideAutoStart(input: AutoStartInput): AutoStartDecision {
	const signature = input.goal ? objectiveSignature(input.goal.objective) : "";
	if (input.inFlight) return { start: false, reason: "an orchestration run is in flight", signature };
	if (!input.goal) return { start: false, reason: "no focused goal", signature };
	if (input.goal.status !== "active") {
		return { start: false, reason: `goal status is ${input.goal.status ?? "unknown"}`, signature };
	}
	if (!input.goal.objective.trim()) return { start: false, reason: "goal objective is empty", signature };

	// An explicit /orchestrate bypasses both the automatic guards.
	if (input.force) return { start: true, reason: "forced by /orchestrate", signature };
	if (!input.enabled) return { start: false, reason: "autoOrchestrate is disabled", signature };
	if (input.goal.autoContinue === false) {
		return { start: false, reason: "goal opted out of autonomous continuation", signature };
	}

	const sameObjectiveRuns = input.runs.filter(
		(run) => run.goalId === input.goal?.id && objectiveSignature(run.objective) === signature,
	);
	if (sameObjectiveRuns.length > 0) {
		return {
			start: false,
			reason: `already orchestrated (${sameObjectiveRuns[sameObjectiveRuns.length - 1]?.runId})`,
			signature,
		};
	}
	if (input.marker && input.marker.goalId === input.goal.id && input.marker.signature === signature) {
		return { start: false, reason: "planning message already queued", signature };
	}
	return { start: true, reason: "newly decided goal", signature };
}

function resolveRoot(cwd: string, artifactsRoot: string): string {
	return path.isAbsolute(artifactsRoot) ? artifactsRoot : path.join(cwd, artifactsRoot);
}

export function autoMarkerPath(cwd: string, artifactsRoot: string, goalId: string): string {
	return path.join(resolveRoot(cwd, artifactsRoot), "auto", `${safeSegment(goalId, "goal")}.json`);
}

export function readAutoMarker(cwd: string, artifactsRoot: string, goalId: string): AutoMarker | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(autoMarkerPath(cwd, artifactsRoot, goalId), "utf8")) as AutoMarker;
		return typeof parsed?.goalId === "string" && typeof parsed?.signature === "string" ? parsed : null;
	} catch {
		return null;
	}
}

export function writeAutoMarker(cwd: string, artifactsRoot: string, marker: AutoMarker): void {
	const file = autoMarkerPath(cwd, artifactsRoot, marker.goalId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
	fs.writeFileSync(temp, JSON.stringify(marker, null, 2), "utf8");
	fs.renameSync(temp, file);
}

/** Completed runs on disk. Missing or malformed run files are ignored. */
export function listRuns(cwd: string, artifactsRoot: string): RunSummary[] {
	const runsDir = path.join(resolveRoot(cwd, artifactsRoot), "runs");
	let names: string[] = [];
	try {
		names = fs.readdirSync(runsDir);
	} catch {
		return [];
	}
	const runs: RunSummary[] = [];
	for (const name of names) {
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(runsDir, name, "run.json"), "utf8")) as RunSummary;
			if (typeof raw?.runId !== "string" || typeof raw?.objective !== "string") continue;
			runs.push({
				runId: raw.runId,
				goalId: typeof raw.goalId === "string" ? raw.goalId : undefined,
				objective: raw.objective,
				status: typeof raw.status === "string" ? raw.status : "unknown",
			});
		} catch {
			// A run directory without a settled run.json is simply not counted.
		}
	}
	return runs;
}

/** The planning message the orchestrator receives when a goal is decided. */
export function autoStartMessage(goal: { id: string; objective: string }, reason: string): string {
	return [
		"[GOAL ORCHESTRATION]",
		`A decided goal is focused (${reason}). All goal work must run in subagents; this session only plans and reviews.`,
		"",
		`Goal: ${goal.id}`,
		`Objective: ${goal.objective}`,
		"",
		"Your next action must be one run_goal_plan call:",
		'- If the goal already has a task list, call run_goal_plan with { "tasks": true }: each pending task runs as one audited node in order, plus an integrated verification node.',
		"- Otherwise pass an explicit DAG: contract/interface first, parallel writers next (isolation \"worktree\" when they touch files), integrated verification last.",
		"Each node prompt is a self-contained brief (workers never see this conversation) and declares its expected outputs.",
		"Do not perform the goal work inline: write/edit are blocked until the goal has an orchestration run. Keep this context for planning, review and the final report.",
	].join("\n");
}
