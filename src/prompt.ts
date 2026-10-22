/**
 * Prompt builders and the compact report returned to the orchestrator.
 *
 * Workers get a self-contained brief, never the parent transcript. This is the
 * whole point of the extension: independent work runs in small contexts, and
 * only summaries flow back.
 */

import type { NodeAuditResult, PlanNode, RunResult } from "./types.ts";

export function excerpt(text: string, max: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max - 1)}…`;
}

export interface WorkerPromptArgs {
	objective: string;
	node: PlanNode;
	deps: PlanNode[];
	attempt: number;
	/** Auditor feedback from the previous rejected attempt. */
	feedback?: string;
	artifactsDir: string;
}

export function buildWorkerPrompt(args: WorkerPromptArgs): string {
	const { objective, node, deps, attempt, feedback, artifactsDir } = args;
	const lines: string[] = [
		"You are a worker agent executing one node of a larger plan. Work only on this node.",
		"",
		"Plan objective:",
		"<objective>",
		objective,
		"</objective>",
		"",
		`Node: ${node.id} — ${node.title}`,
		"",
		"Task:",
		"<task>",
		node.prompt,
		"</task>",
	];

	if (node.outputs.length > 0) {
		lines.push("", "Expected outputs (paths relative to the repository root):");
		for (const output of node.outputs) lines.push(`- ${output}`);
		lines.push("Create or update these paths. The orchestrator checks that they exist.");
	}

	if (deps.length > 0) {
		lines.push("", "Completed dependency context (use it, do not redo it):");
		for (const dep of deps) {
			lines.push(
				"",
				`<dependency id="${dep.id}" title="${dep.title.replace(/"/g, "&quot;")}">`,
				`Result summary: ${excerpt(dep.summary || dep.result || "(no summary)", 1600)}`,
				dep.branch ? `Worktree branch: ${dep.branch} (merge or inspect it before integrating)` : "",
				dep.artifactDir ? `Artifacts: ${dep.artifactDir}` : "",
				`</dependency>`,
			);
		}
	}

	if (feedback) {
		lines.push(
			"",
			`This is attempt ${attempt}. The independent auditor rejected the previous attempt:`,
			"<audit_feedback>",
			excerpt(feedback, 3000),
			"</audit_feedback>",
			"Fix the specific problems above. Do not repeat the same result.",
		);
	}

	if (node.isolation === "worktree") {
		lines.push(
			"",
			"You are running in an isolated git worktree. pi-subagents commits your changes to a branch when you finish; the main checkout will not contain them yet. Do not merge the branch yourself.",
		);
	}

	lines.push(
		"",
		"Rules:",
		"- Do not create, update, pause, resume, or audit plans. Do not run orchestration tools.",
		"- Do not ask the user questions. If something is genuinely blocked, say BLOCKED and explain why.",
		"- Stay inside the task scope. Do not refactor unrelated code or add unrequested features.",
		"- Actually run the checks you can run, and report their real output.",
		"- Work on real artifacts, not a plan or a promise to do the work later.",
		"",
		`Artifacts directory for this run: ${artifactsDir}`,
		"",
		"End your final message with these lines (keep each value short):",
		"SUMMARY: what you changed and why",
		"FILES: comma-separated paths",
		"TESTS: commands run and pass/fail",
		"RISKS: anything the auditor should know",
	);
	return lines.filter((line) => line !== undefined).join("\n");
}

export interface AuditorPromptArgs {
	objective: string;
	node: PlanNode;
	workerResult: string;
	artifactsDir: string;
	attempt: number;
	/** Worktree branch auto-committed by pi-subagents, when the node was isolated. */
	branch?: string;
}

export function buildAuditorPrompt(args: AuditorPromptArgs): string {
	const { objective, node, workerResult, artifactsDir, attempt, branch } = args;
	return [
		"You are the independent auditor for one node of a larger plan.",
		"Decide whether this node's actual work satisfies its task. The worker's claim is untrusted evidence.",
		"",
		"Inspect real artifacts with read/grep/find/ls/bash. Do not modify files.",
		"Check, in order:",
		"1. Every explicit requirement in the task.",
		"2. The expected outputs exist and contain real work, not placeholders.",
		"3. The worker did not silently skip, stub, or fake verification.",
		"4. The result is usable by dependent nodes (contracts and interfaces are complete).",
		"",
		"Plan objective:",
		"<objective>",
		objective,
		"</objective>",
		"",
		`Node: ${node.id} — ${node.title} (attempt ${attempt})`,
		"<task>",
		node.prompt,
		"</task>",
		"",
		"Expected outputs:",
		...node.outputs.map((output) => `- ${output}`),
		"",
		"Artifacts directory:",
		artifactsDir,
		...(branch
			? [
					"",
					`This node ran in an isolated git worktree. Its changes are on branch \`${branch}\`, not in the working tree.`,
					`Inspect them with bash: \`git show ${branch}:<path>\`, \`git diff <base>...${branch}\`, or \`git log ${branch}\`.`,
				]
			: []),
		"",
		"Worker final report (UNTRUSTED):",
		"<worker_report>",
		excerpt(workerResult, 8000),
		"</worker_report>",
		"",
		"Be strict but concrete. If something is missing, name the file/behavior and what must change.",
		"End with exactly one marker on the final line:",
		"<approved/>",
		"or",
		"<disapproved/>",
	].join("\n");
}

export function parseAuditDecision(output: string): { approved: boolean; disapproved: boolean } {
	const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
	const marker = lines[lines.length - 1];
	return { approved: marker === "<approved/>", disapproved: marker === "<disapproved/>" };
}

function auditLabel(audit?: NodeAuditResult): string {
	if (!audit) return "not audited";
	return audit.approved ? "approved" : "rejected";
}

/**
 * A compact report for the orchestrator's context. Full transcripts and audit
 * reports stay on disk; this is deliberately bounded.
 */
export function buildRunReport(result: RunResult, maxChars = 18_000): string {
	const lines: string[] = [
		`Plan orchestration ${result.status.toUpperCase()}${result.planNumber === undefined ? " (ad-hoc)" : ` for plan #${result.planNumber}`}.`,
		`Run: ${result.runId}`,
		`Artifacts: ${result.artifactDir}`,
		"",
		"Nodes:",
	];
	for (const node of result.nodes) {
		lines.push(
			`- [${node.status}] ${node.id}: ${node.title} ` +
				`(attempts ${node.attempts}, audit ${auditLabel(node.lastAudit)}, agent ${node.agentId ?? "none"})`,
		);
		if (node.branch) lines.push(`  branch: ${node.branch}`);
		if (node.error) lines.push(`  error: ${excerpt(node.error, 500)}`);
		if (node.summary) lines.push(`  summary: ${excerpt(node.summary, 1000)}`);
		if (node.lastAudit && !node.lastAudit.approved) {
			lines.push(`  audit: ${excerpt(node.lastAudit.output || node.lastAudit.error || "rejected", 800)}`);
		}
	}

	if (result.error) lines.push("", `Failure: ${excerpt(result.error, 1500)}`);
	lines.push(
		"",
		`Usage: input ${result.usage.input} (including audit ${Math.round(result.usage.auditInput)}), output ${result.usage.output} (including audit ${Math.round(result.usage.auditOutput)}), cost $${result.usage.cost.toFixed(4)}`,
		"",
		"Next: inspect failed/rejected artifacts before re-planning. A run whose nodes are all done is complete; report it and let the user start the next plan.",
	);
	const report = lines.join("\n");
	return report.length > maxChars ? `${report.slice(0, maxChars - 1)}…` : report;
}

/** Parse the worker's trailing SUMMARY/FILES/TESTS/RISKS block, best effort. */
export function extractWorkerSummary(result: string): string {
	const summary = result.match(/^\s*SUMMARY:\s*(.+)$/im)?.[1]?.trim();
	const files = result.match(/^\s*FILES:\s*(.+)$/im)?.[1]?.trim();
	if (summary && files) return `${summary} (files: ${files})`;
	if (summary) return summary;
	const first = result.trim().split("\n").find((line) => line.trim());
	return first ? excerpt(first, 300) : "";
}

/**
 * Message that starts the planning turn for `/orchestrator-plan`.
 * The plan is persisted by the tool; execution is a separate command.
 */
export function buildPlanningPrompt(draft: string): string {
	return [
		"[ORCHESTRATOR PLAN]",
		"You are planning, not executing. No goal work happens in this turn.",
		"",
		"Draft:",
		draft.trim(),
		"",
		"1. Sharpen the objective: scope, non-goals, constraints, and what 'done' means.",
		"   Ask the user at most two questions, and only when the answer changes the plan.",
		"   Otherwise state your assumptions explicitly.",
		"2. Decompose it into small nodes with explicit dependencies. Put a contract/interface node",
		"   first when work touches a shared surface, parallel implementation nodes next, and an",
		"   integrated verification node last. Each node prompt is self-contained: the worker never",
		"   sees this conversation. Declare expected outputs when you know the paths.",
		"3. Call orchestrator_plan with title, objective, requirements, notes, and nodes.",
		"   Use 'isolation: \"worktree\"' for parallel writers that touch files.",
		"",
		"Do not call orchestrator_run in this turn. The plan gets a number and waits for",
		"/orchestrator-resume.",
	].join("\n");
}

/** Message that starts execution of an existing plan. */
export function buildResumePrompt(plan: {
	number: number;
	title: string;
	objective: string;
	nodes: Array<{ id: string; title?: string }>;
}): string {
	return [
		`[ORCHESTRATOR RESUME] Plan #${plan.number}: ${plan.title}`,
		`Objective: ${plan.objective}`,
		`Nodes: ${plan.nodes.map((node) => node.id).join(" → ")}`,
		"",
		`Call orchestrator_run with { "plan_number": ${plan.number} } now.`,
		"The tool executes the stored DAG in subagents; do not do node work inline.",
		"When it returns, read the compact report and relay the outcome. Do not start another plan.",
	].join("\n");
}
