/**
 * Durable run artifacts.
 *
 * Each run gets a directory under `.pi/goals/orchestrator/runs/<runId>/`.
 * Worker transcripts stay in pi-subagents' own session/output files; what is
 * written here is the compact contract: the plan, per-node result, auditor
 * verdict, usage, and a run.json that the status command can read.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { NormalizedPlan, PlanNode, RunResult } from "./types.ts";

export const LATEST_POINTER = "latest.json";

function safeSegment(value: string, fallback: string): string {
	const clean = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
	return clean || fallback;
}

function writeAtomic(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temp = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
	fs.writeFileSync(temp, content, "utf8");
	fs.renameSync(temp, filePath);
}

export function makeRunId(goalId?: string): string {
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	return `${stamp}-${safeSegment(goalId ?? "goal", "goal")}-${randomUUID().slice(0, 8)}`;
}

export class RunArtifacts {
	readonly cwd: string;
	readonly runId: string;
	readonly root: string;

	constructor(cwd: string, root: string, runId: string) {
		this.cwd = cwd;
		this.runId = runId;
		this.root = path.isAbsolute(root) ? path.join(root, "runs", runId) : path.join(cwd, root, "runs", runId);
	}

	/** Relative path is what prompts show; absolute is what the extension writes. */
	relative(filePath: string): string {
		return path.relative(this.cwd, filePath).split(path.sep).join("/");
	}

	writePlan(plan: NormalizedPlan): void {
		writeAtomic(
			path.join(this.root, "plan.json"),
			JSON.stringify(
				{
					goalId: plan.goalId,
					objective: plan.objective,
					maxConcurrent: plan.maxConcurrent,
					failFast: plan.failFast,
					audit: plan.audit,
					nodes: plan.nodes.map((node) => ({
						id: node.id,
						title: node.title,
						deps: node.deps,
						agentType: node.agentType,
						model: node.model,
						thinkingLevel: node.thinkingLevel,
						isolation: node.isolation,
						maxTurns: node.maxTurns,
						timeoutMs: node.timeoutMs,
						audit: node.audit,
						maxAttempts: node.maxAttempts,
						outputs: node.outputs,
						prompt: node.prompt,
					})),
				},
				null,
				2,
			),
		);
	}

	nodeDir(node: PlanNode): string {
		const dir = path.join(this.root, "nodes", safeSegment(node.id, "node"));
		fs.mkdirSync(dir, { recursive: true });
		node.artifactDir = dir;
		return dir;
	}

	writeNode(node: PlanNode): void {
		const dir = this.nodeDir(node);
		writeAtomic(path.join(dir, "node.json"), JSON.stringify(node, null, 2));
		if (node.result) writeAtomic(path.join(dir, `result-attempt-${node.attempts}.md`), node.result);
	}

	writeBrief(node: PlanNode, prompt: string): void {
		const dir = this.nodeDir(node);
		writeAtomic(path.join(dir, `brief-attempt-${node.attempts}.md`), prompt);
	}

	writeAudit(node: PlanNode, output: string): void {
		const dir = this.nodeDir(node);
		writeAtomic(path.join(dir, `audit-attempt-${node.attempts}.md`), output);
	}

	writeRun(result: RunResult): void {
		const json = JSON.stringify(result, null, 2);
		writeAtomic(path.join(this.root, "run.json"), json);
		writeAtomic(
			path.join(this.root, "report.md"),
			[
				`# Goal orchestration ${result.status}`,
				"",
				`- Run: ${result.runId}`,
				`- Goal: ${result.goalId ?? "(none)"}`,
				`- Objective: ${result.objective}`,
				`- Started: ${result.startedAt}`,
				`- Completed: ${result.completedAt}`,
				`- Artifacts: ${this.relative(this.root)}`,
				"",
				...result.nodes.map((node) => {
					const audit = node.lastAudit ? (node.lastAudit.approved ? "approved" : "rejected") : "not audited";
					return `- [${node.status}] ${node.id}: ${node.title} (attempts ${node.attempts}, audit ${audit})`;
				}),
			].join("\n"),
		);
		const parent = path.dirname(this.root);
		writeAtomic(
			path.join(parent, LATEST_POINTER),
			JSON.stringify(
				{
					runId: result.runId,
					status: result.status,
					goalId: result.goalId,
					objective: result.objective,
					artifactDir: this.root,
					startedAt: result.startedAt,
					completedAt: result.completedAt,
					nodes: result.nodes.map((node) => ({ id: node.id, title: node.title, status: node.status })),
				},
				null,
				2,
			),
		);
	}
}

export interface LatestRun {
	runId: string;
	status: string;
	goalId?: string;
	objective: string;
	artifactDir: string;
	startedAt: string;
	completedAt: string;
	nodes: Array<{ id: string; title: string; status: string }>;
}

export function readLatestRun(cwd: string, root: string): LatestRun | null {
	const file = path.isAbsolute(root)
		? path.join(root, LATEST_POINTER)
		: path.join(cwd, root, LATEST_POINTER);
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as LatestRun;
	} catch {
		return null;
	}
}
