/**
 * Deterministic DAG executor.
 *
 * Readiness is dependency-driven, not wave-driven: any pending node whose deps
 * are done starts as soon as a concurrency slot is free. A node only becomes
 * `done` after its independent audit approves it. A rejected node is retried
 * with the auditor's objections in its prompt; after `maxAttempts` it fails and
 * its dependents become blocked.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { allDone, blockedNodes, readyNodes, totalUsage } from "./dag.ts";
import { RunArtifacts } from "./artifacts.ts";
import { runNodeAuditor } from "./audit.ts";
import { buildWorkerPrompt, excerpt, extractWorkerSummary } from "./prompt.ts";
import { RpcTimeoutError, type SubagentBridge } from "./rpc.ts";
import type { NodeUsage, NormalizedPlan, PlanNode, RunProgress, RunResult, WorkerOutcome } from "./types.ts";

export interface RunPlanArgs {
	ctx: ExtensionContext;
	plan: NormalizedPlan;
	bridge: SubagentBridge;
	artifacts: RunArtifacts;
	signal?: AbortSignal;
	onProgress?: (progress: RunProgress) => void;
	runAudit?: typeof runNodeAuditor;
}

function nowIso(): string {
	return new Date().toISOString();
}

function progress(plan: NormalizedPlan, artifacts: RunArtifacts): RunProgress {
	return {
		runId: artifacts.runId,
		planNumber: plan.planNumber,
		artifactDir: artifacts.relative(artifacts.root),
		nodes: plan.nodes.map((node) => ({
			id: node.id,
			status: node.status,
			attempts: node.attempts,
			agentId: node.agentId,
			lastAudit: node.lastAudit ? (node.lastAudit.approved ? "approved" : "rejected") : undefined,
		})),
	};
}

function addUsage(target: NodeUsage, delta: NodeUsage): void {
	target.input += delta.input;
	target.output += delta.output;
	target.cacheRead += delta.cacheRead;
	target.cacheWrite += delta.cacheWrite;
	target.cost += delta.cost;
	target.auditInput += delta.auditInput;
	target.auditOutput += delta.auditOutput;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function missingOutputs(cwd: string, node: PlanNode): string[] {
	return node.outputs.filter((output) => {
		const resolved = path.resolve(cwd, output);
		const relative = path.relative(cwd, resolved);
		if (relative.startsWith("..") || path.isAbsolute(relative)) return true;
		// A worktree node's changes live on its branch, not in the main tree.
		if (node.isolation === "worktree" && node.branch) {
			try {
				execFileSync("git", ["-C", cwd, "cat-file", "-e", `${node.branch}:${output}`], { stdio: "ignore" });
				return false;
			} catch {
				return true;
			}
		}
		return !fs.existsSync(resolved);
	});
}

export async function runPlan(args: RunPlanArgs): Promise<RunResult> {
	const { ctx, plan, bridge, artifacts, signal } = args;
	const runAudit = args.runAudit ?? runNodeAuditor;
	const startedAt = nowIso();
	const running = new Set<Promise<void>>();
	let aborted = false;
	let firstFailure: string | undefined;

	const emit = () => {
		try {
			args.onProgress?.(progress(plan, artifacts));
		} catch {
			// UI progress must never break execution.
		}
	};

	const stopAll = () => {
		for (const node of plan.nodes) {
			if ((node.status === "running" || node.status === "auditing") && node.agentId) {
				void bridge.stop(node.agentId);
			}
		}
	};
	const onAbort = () => {
		aborted = true;
		stopAll();
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	const executeNode = async (node: PlanNode): Promise<void> => {
		const deps = node.deps
			.map((id) => plan.nodes.find((candidate) => candidate.id === id))
			.filter((dep): dep is PlanNode => !!dep);

		while (node.attempts < node.maxAttempts) {
			if (signal?.aborted) {
				node.status = "stopped";
				node.error = "Orchestration aborted.";
				artifacts.writeNode(node);
				emit();
				return;
			}
			node.attempts += 1;
			node.status = "running";
			node.error = undefined;
			node.agentId = undefined;
			const feedback = node.lastAudit ? node.lastAudit.output || node.lastAudit.error : undefined;
			const prompt = buildWorkerPrompt({
				objective: plan.objective,
				node,
				deps,
				attempt: node.attempts,
				feedback,
				artifactsDir: artifacts.relative(artifacts.root),
			});
			artifacts.writeBrief(node, prompt);
			artifacts.writeNode(node);
			emit();

			let outcome: WorkerOutcome;
			try {
				const agentId = await bridge.spawn({
					type: node.agentType,
					prompt,
					options: {
						description: `${plan.planNumber === undefined ? "adhoc" : `plan-${plan.planNumber}`}/${node.id}`,
						name: `${plan.planNumber === undefined ? "plan" : `plan-${plan.planNumber}`}-${node.id}`.slice(0, 60),
						model: node.model,
						thinkingLevel: node.thinkingLevel,
						maxTurns: node.maxTurns,
						inheritContext: false,
						isBackground: true,
						isolation: node.isolation,
					},
				});
				node.agentId = agentId;
				node.startedAt = nowIso();
				artifacts.writeNode(node);
				emit();
				outcome = await bridge.waitFor(agentId, node.timeoutMs, signal);
			} catch (error) {
				node.error = errorMessage(error);
				if (error instanceof RpcTimeoutError && node.agentId) void bridge.stop(node.agentId);
				if (signal?.aborted) {
					node.status = "stopped";
					node.error = "Orchestration aborted.";
					artifacts.writeNode(node);
					emit();
					return;
				}
				if (node.attempts >= node.maxAttempts) {
					node.status = "failed";
					node.completedAt = nowIso();
					firstFailure ??= `${node.id}: ${node.error}`;
					artifacts.writeNode(node);
					emit();
					return;
				}
				artifacts.writeNode(node);
				emit();
				continue;
			}

			addUsage(node.usage, outcome.usage);
			node.branch = outcome.branch;
			const succeeded = outcome.status === "completed" || outcome.status === "steered";
			if (!succeeded) {
				node.error = `Worker ended ${outcome.status}: ${outcome.error ?? excerpt(outcome.result, 600)}`;
				if (node.attempts >= node.maxAttempts) {
					node.status = "failed";
					node.completedAt = nowIso();
					firstFailure ??= `${node.id}: ${node.error}`;
					artifacts.writeNode(node);
					emit();
					return;
				}
				artifacts.writeNode(node);
				emit();
				continue;
			}

			node.result = outcome.result.trim() || "(worker returned no text)";
			node.summary = extractWorkerSummary(node.result);
			artifacts.writeNode(node);

			const missing = missingOutputs(ctx.cwd, node);
			if (missing.length > 0) {
				node.error = `Missing expected outputs: ${missing.join(", ")}`;
				if (node.attempts >= node.maxAttempts) {
					node.status = "failed";
					node.completedAt = nowIso();
					firstFailure ??= `${node.id}: ${node.error}`;
					artifacts.writeNode(node);
					emit();
					return;
				}
				artifacts.writeNode(node);
				emit();
				continue;
			}

			if (!node.audit) {
				node.status = "done";
				node.completedAt = nowIso();
				artifacts.writeNode(node);
				emit();
				return;
			}

			node.status = "auditing";
			artifacts.writeNode(node);
			emit();
			const audit = await runAudit({
				ctx,
				objective: plan.objective,
				node,
				workerResult: node.result,
				artifactsDir: artifacts.relative(artifacts.root),
				attempt: node.attempts,
				modelSpec: plan.audit.model,
				thinkingLevel: plan.audit.thinkingLevel,
				timeoutMs: node.timeoutMs,
				signal,
				branch: node.branch,
			});
			if (audit.usage) {
				node.usage.auditInput += audit.usage.input + audit.usage.cacheRead;
				node.usage.auditOutput += audit.usage.output;
			}
			node.lastAudit = audit;
			node.auditHistory.push(audit);
			artifacts.writeAudit(node, audit.output || audit.error || "(no audit output)");
			artifacts.writeNode(node);
			emit();

			if (audit.approved) {
				node.status = "done";
				node.completedAt = nowIso();
				artifacts.writeNode(node);
				emit();
				return;
			}

			node.error = `Audit rejected: ${excerpt(audit.output || audit.error || "no reason given", 800)}`;
			if (node.attempts >= node.maxAttempts || signal?.aborted) {
				node.status = signal?.aborted ? "stopped" : "failed";
				node.completedAt = nowIso();
				if (!signal?.aborted) firstFailure ??= `${node.id}: ${node.error}`;
				artifacts.writeNode(node);
				emit();
				return;
			}
			artifacts.writeNode(node);
			emit();
		}
	};

	const start = (node: PlanNode) => {
		const promise = executeNode(node)
			.catch((error) => {
				node.status = "failed";
				node.error = errorMessage(error);
				node.completedAt = nowIso();
				firstFailure ??= `${node.id}: ${node.error}`;
				artifacts.writeNode(node);
				emit();
			})
			.finally(() => {
				running.delete(promise);
			});
		running.add(promise);
	};

	try {
		while (true) {
			if (signal?.aborted) {
				aborted = true;
				stopAll();
				break;
			}
			const failed = plan.nodes.some((node) => node.status === "failed");
			if (plan.failFast && failed) {
				// Stop scheduling new work, but let in-flight agents settle. Returning
				// while they still run would leave them mutating the tree after the
				// tool result.
				firstFailure ??= plan.nodes.find((node) => node.status === "failed")?.error;
				if (running.size === 0) break;
				await Promise.race([...running]);
				continue;
			}
			const ready = readyNodes(plan.nodes);
			while (ready.length > 0 && running.size < plan.maxConcurrent) {
				start(ready.shift()!);
			}
			if (running.size === 0) break;
			await Promise.race([...running]);
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}

	// On abort, stopped agents settle through their waiters; give them a moment
	// but never hang the tool on an unresponsive child.
	if (running.size > 0) {
		await Promise.race([
			Promise.allSettled([...running]),
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 5000);
				timer.unref?.();
			}),
		]);
	}

	for (const node of plan.nodes) {
		if (node.status === "running" || node.status === "auditing") {
			node.status = "stopped";
			node.error ??= aborted ? "Orchestration aborted." : "Orchestration stopped before this agent settled.";
		}
	}

	// Anything still pending depends (transitively) on a failed/stopped node.
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of blockedNodes(plan.nodes)) {
			node.status = "blocked";
			node.error = `Blocked by ${node.deps.filter((dep) => {
				const status = plan.nodes.find((candidate) => candidate.id === dep)?.status;
				return status === "failed" || status === "blocked" || status === "stopped";
			}).join(", ")}`;
			changed = true;
		}
	}

	const usage = totalUsage(plan.nodes);
	const status: RunResult["status"] = aborted ? "aborted" : allDone(plan.nodes) ? "complete" : "failed";
	const failedNode = plan.nodes.find((node) => node.status === "failed" || node.status === "blocked");
	const result: RunResult = {
		runId: artifacts.runId,
		status,
		artifactDir: artifacts.relative(artifacts.root),
		objective: plan.objective,
		planNumber: plan.planNumber,
		nodes: plan.nodes,
		startedAt,
		completedAt: nowIso(),
		usage: { ...usage, auditInput: 0, auditOutput: 0 },
		error: status === "complete" ? undefined : firstFailure ?? failedNode?.error ?? (aborted ? "Orchestration aborted." : undefined),
	};
	result.usage.auditInput = plan.nodes.reduce((sum, node) => sum + node.usage.auditInput, 0);
	result.usage.auditOutput = plan.nodes.reduce((sum, node) => sum + node.usage.auditOutput, 0);
	artifacts.writeRun(result);
	emit();
	return result;
}
