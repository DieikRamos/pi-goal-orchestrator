/**
 * pi-goal-orchestrator
 *
 * An independent plan orchestrator: `/orchestrator-plan` turns a draft into a
 * numbered, persisted plan; `/orchestrator-resume` executes it as a DAG of
 * audited subagents. The main session only plans, reviews and reports, so its
 * context stays small. No dependency on pi-goal-x.
 */

import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { makeRunId, readLatestRun, RunArtifacts } from "../src/artifacts.ts";
import { PlanValidationError, normalizePlan } from "../src/dag.ts";
import {
	formatPlanList,
	nodeSpecFromNormalized,
	PlanStore,
	planSummaryLine,
	resolveResumeTarget,
	type PlanRecord,
	type PlanStatus,
} from "../src/plans.ts";
import { buildPlanningPrompt, buildResumePrompt, buildRunReport } from "../src/prompt.ts";
import { SubagentBridge, RpcError } from "../src/rpc.ts";
import { runPlan } from "../src/scheduler.ts";
import { loadSettings, type OrchestratorSettings } from "../src/settings.ts";
import { OrchestratorWidget } from "../src/ui.ts";
import type { PlanAuditSpec, PlanNodeSpec, PlanSpec, RunProgress } from "../src/types.ts";

const PLAN_TOOL = "orchestrator_plan";
const RUN_TOOL = "orchestrator_run";
const PLAN_MESSAGE = "pi-orchestrator-plan";
const RESUME_MESSAGE = "pi-orchestrator-resume";

const widget = new OrchestratorWidget();

function childSession(): boolean {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH);
	return process.env.PI_SUBAGENT_CHILD === "1" || (Number.isFinite(depth) && depth > 0);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	try {
		ctx.ui.notify(message, level);
	} catch {
		// headless mode may not have a UI
	}
}

function progressText(progress: RunProgress): string {
	const counts = new Map<string, number>();
	for (const node of progress.nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
	const summary = [...counts.entries()].map(([status, count]) => `${status} ${count}`).join(", ");
	return [
		`Orchestration ${progress.planNumber === undefined ? "(ad-hoc)" : `plan #${progress.planNumber}`} · ${progress.runId}`,
		summary,
		...progress.nodes.map(
			(node) =>
				`- ${node.id}: ${node.status}${node.attempts > 1 ? ` (attempt ${node.attempts})` : ""}` +
				`${node.agentId ? ` [${node.agentId.slice(0, 8)}]` : ""}` +
				`${node.lastAudit ? ` audit ${node.lastAudit}` : ""}`,
		),
	].join("\n");
}

function applyDefaults(spec: PlanSpec, settings: OrchestratorSettings): PlanSpec {
	return {
		...spec,
		max_concurrent: spec.max_concurrent ?? settings.maxConcurrent,
		fail_fast: spec.fail_fast ?? settings.failFast,
		audit: {
			enabled: spec.audit?.enabled ?? settings.audit.enabled,
			model: spec.audit?.model ?? settings.audit.model,
			thinking_level: spec.audit?.thinking_level ?? settings.audit.thinkingLevel,
		},
		nodes: spec.nodes.map((node) => ({
			...node,
			model: node.model ?? settings.worker.model,
			thinking_level: node.thinking_level ?? settings.worker.thinkingLevel,
			timeout_seconds: node.timeout_seconds ?? settings.defaultTimeoutSeconds,
			max_attempts: node.max_attempts ?? settings.defaultMaxAttempts,
		})),
	};
}

function usageForToolResult(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}) {
	const totalTokens = usage.input + usage.output + usage.cacheWrite + usage.cacheRead;
	if (totalTokens <= 0) return undefined;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
	};
}

function storeFor(ctx: ExtensionContext, settings: OrchestratorSettings): PlanStore {
	return new PlanStore(ctx.cwd, settings.artifactsRoot);
}

function refreshWidget(ctx: ExtensionContext, settings: OrchestratorSettings, progress?: RunProgress): void {
	try {
		const store = storeFor(ctx, settings);
		const plans = store.list();
		const planNumber = progress?.planNumber;
		const plan = planNumber === undefined ? undefined : plans.find((candidate) => candidate.number === planNumber);
		widget.setView({
			plans,
			active:
				progress === undefined
					? undefined
					: {
							number: planNumber,
							title: plan?.title ?? "Ad-hoc run",
							status: plan?.status ?? "running",
							total: progress.nodes.length,
							progress,
						},
		});
	} catch {
		// The widget is a convenience; never let it break a run.
	}
}

function relativeTo(ctx: ExtensionContext, filePath: string): string {
	return path.relative(ctx.cwd, filePath).split(path.sep).join("/") || ".";
}

function planStatusFromRun(status: "complete" | "failed" | "aborted"): PlanStatus {
	return status === "complete" ? "complete" : status === "aborted" ? "aborted" : "failed";
}

function createPlanTool(pi: ExtensionAPI) {
	return defineTool({
		name: PLAN_TOOL,
		label: "Plan Orchestration",
		description:
			"Create a numbered, persisted orchestration plan. Refine the objective, then pass title, objective and a DAG of nodes (or omit nodes for a single node). This does not execute anything: the plan waits for /orchestrator-resume or orchestrator_run.",
		promptSnippet: "Create a numbered plan for later audited execution.",
		promptGuidelines: [
			"Use orchestrator_plan when the user asks to plan or prepare work; never execute node work inline.",
			"Make node prompts self-contained (workers never see this conversation) and declare expected outputs when known.",
			"Put a contract/interface node first, parallel writers next, and an integrated verification node last.",
			"The plan number is allocated by the tool; report it and tell the user to run /orchestrator-resume <n>.",
		],
		parameters: Type.Object(
			{
				title: Type.String({ description: "Short human title, e.g. 'CSV export'." }),
				objective: Type.String({ description: "Refined objective: scope, non-goals, and what done means." }),
				description: Type.Optional(Type.String({ description: "Original draft the plan came from." })),
				requirements: Type.Optional(Type.Array(Type.String(), { description: "Explicit acceptance requirements." })),
				notes: Type.Optional(Type.String({ description: "Assumptions, constraints, or open questions." })),
				nodes: Type.Optional(
					Type.Array(
						Type.Object(
							{
								id: Type.String({ description: "Stable short id, e.g. contract, backend, verify." }),
								title: Type.Optional(Type.String()),
								prompt: Type.String({ description: "Self-contained worker brief." }),
								deps: Type.Optional(Type.Array(Type.String())),
								agent_type: Type.Optional(Type.String()),
								model: Type.Optional(Type.String()),
								thinking_level: Type.Optional(Type.String()),
								isolation: Type.Optional(Type.String({ description: "worktree for parallel writers; off otherwise." })),
								max_turns: Type.Optional(Type.Number()),
								timeout_seconds: Type.Optional(Type.Number()),
								audit: Type.Optional(Type.Boolean()),
								max_attempts: Type.Optional(Type.Number()),
								outputs: Type.Optional(Type.Array(Type.String())),
							},
							{ additionalProperties: false },
						),
						{ minItems: 1, maxItems: 32 },
					),
				),
				max_concurrent: Type.Optional(Type.Number()),
				fail_fast: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (childSession()) {
				return {
					content: [{ type: "text" as const, text: "orchestrator_plan is disabled inside a subagent." }],
					details: { error: true },
					isError: true,
				};
			}
			const settings = loadSettings(ctx.cwd);
			const title = params.title.trim();
			const objective = params.objective.trim();
			const nodes =
				(params.nodes as PlanNodeSpec[] | undefined) && (params.nodes as PlanNodeSpec[]).length > 0
					? (params.nodes as PlanNodeSpec[])
					: [
							{
								id: "goal",
								title: title.slice(0, 120),
								prompt: objective,
								audit: true,
							} satisfies PlanNodeSpec,
						];

			let plan;
			try {
				plan = normalizePlan(
					applyDefaults(
						{
							objective,
							nodes,
							max_concurrent: params.max_concurrent,
							fail_fast: params.fail_fast,
						},
						settings,
					),
				);
			} catch (error) {
				const message = error instanceof PlanValidationError ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Plan rejected: ${message}` }],
					details: { error: true },
					isError: true,
				};
			}

			const store = storeFor(ctx, settings);
			const saved = store.create({
				title,
				objective,
				description: params.description,
				requirements: params.requirements,
				notes: params.notes,
				nodes: plan.nodes.map(nodeSpecFromNormalized),
				maxConcurrent: plan.maxConcurrent,
				failFast: plan.failFast,
			});
			refreshWidget(ctx, settings);

			return {
				content: [
					{
						type: "text" as const,
						text: [
							`Plan #${saved.number} saved: ${saved.title}`,
							`Nodes: ${saved.nodes.map((node) => node.id).join(" → ")}`,
							`Artifact: ${relativeTo(ctx, store.dir(saved.number))}/plan.md`,
							"",
							`Execute it with /orchestrator-resume ${saved.number} (or orchestrator_run with plan_number ${saved.number}).`,
						].join("\n"),
					},
				],
				details: { planNumber: saved.number, nodeCount: saved.nodes.length, artifactDir: store.dir(saved.number) },
			};
		},
	});
}

function createRunTool(pi: ExtensionAPI) {
	return defineTool({
		name: RUN_TOOL,
		label: "Run Orchestration Plan",
		description:
			"Execute a stored numbered plan (pass plan_number) or an ad-hoc DAG (pass nodes and objective) as audited subagents. Each node runs in its own context and is independently audited before dependent nodes start. Do not do node work inline.",
		promptSnippet: "Execute a stored plan as a DAG of audited subagents.",
		promptGuidelines: [
			"Use orchestrator_run with plan_number to execute a plan created by /orchestrator-plan; do not re-plan the nodes.",
			"A node only unblocks dependents after its independent audit approves; inspect the compact report afterwards.",
			"Use isolation \"worktree\" for parallel writers, and merge the branches in an integration node.",
		],
		parameters: Type.Object(
			{
				plan_number: Type.Optional(Type.Number({ description: "Stored plan to execute. Mutually exclusive with nodes." })),
				objective: Type.Optional(Type.String({ description: "Objective for an ad-hoc run." })),
				nodes: Type.Optional(
					Type.Array(
						Type.Object(
							{
								id: Type.String(),
								title: Type.Optional(Type.String()),
								prompt: Type.String(),
								deps: Type.Optional(Type.Array(Type.String())),
								agent_type: Type.Optional(Type.String()),
								model: Type.Optional(Type.String()),
								thinking_level: Type.Optional(Type.String()),
								isolation: Type.Optional(Type.String()),
								max_turns: Type.Optional(Type.Number()),
								timeout_seconds: Type.Optional(Type.Number()),
								audit: Type.Optional(Type.Boolean()),
								max_attempts: Type.Optional(Type.Number()),
								outputs: Type.Optional(Type.Array(Type.String())),
							},
							{ additionalProperties: false },
						),
						{ minItems: 1, maxItems: 32 },
					),
				),
				max_concurrent: Type.Optional(Type.Number()),
				fail_fast: Type.Optional(Type.Boolean()),
				audit: Type.Optional(
					Type.Object(
						{
							enabled: Type.Optional(Type.Boolean()),
							model: Type.Optional(Type.String()),
							thinking_level: Type.Optional(Type.String()),
						},
						{ additionalProperties: false },
					),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (childSession()) {
				return {
					content: [{ type: "text" as const, text: "orchestrator_run is disabled inside a subagent." }],
					details: { error: true },
					isError: true,
				};
			}

			const settings = loadSettings(ctx.cwd);
			const store = storeFor(ctx, settings);
			const explicitNodes = (params.nodes ?? []) as PlanNodeSpec[];

			if (params.plan_number !== undefined && explicitNodes.length > 0) {
				return {
					content: [{ type: "text" as const, text: "Pass either plan_number or nodes, not both." }],
					details: { error: true },
					isError: true,
				};
			}

			let stored: PlanRecord | null = null;
			let nodes = explicitNodes;
			let objective = params.objective?.trim() ?? "";
			if (params.plan_number !== undefined) {
				stored = store.get(params.plan_number);
				if (!stored) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Plan #${params.plan_number} not found. Use /orchestrator-plan-list.`,
							},
						],
						details: { error: true },
						isError: true,
					};
				}
				nodes = stored.nodes;
				objective = stored.objective;
			} else if (nodes.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Pass plan_number, or nodes plus objective for an ad-hoc run." }],
					details: { error: true },
					isError: true,
				};
			}

			let plan;
			try {
				plan = normalizePlan(
					applyDefaults(
						{
							plan_number: stored?.number,
							objective,
							nodes,
							max_concurrent: params.max_concurrent ?? stored?.maxConcurrent,
							fail_fast: params.fail_fast ?? stored?.failFast,
							audit: params.audit as PlanAuditSpec | undefined,
						},
						settings,
					),
				);
			} catch (error) {
				const message = error instanceof PlanValidationError ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Plan rejected: ${message}` }],
					details: { error: true },
					isError: true,
				};
			}

			const bridge = new SubagentBridge(pi.events);
			let planNumber = stored?.number;
			try {
				try {
					await bridge.ping(3000);
				} catch (error) {
					throw new RpcError(
						`pi-subagents is not available in this session (${error instanceof Error ? error.message : String(error)}). Install npm:@tintinweb/pi-subagents or enable it for this project.`,
					);
				}

				const runId = makeRunId(planNumber);
				const artifacts = new RunArtifacts(ctx.cwd, settings.artifactsRoot, runId);
				artifacts.writePlan(plan);
				if (planNumber !== undefined) {
					store.update(planNumber, { status: "running", runId, runStatus: "running", lastRunAt: new Date().toISOString() });
				}
				notify(
					ctx,
					`Orchestration ${planNumber === undefined ? "(ad-hoc)" : `plan #${planNumber}`} started: ${plan.nodes.length} nodes, ${plan.maxConcurrent} parallel.`,
				);

				let lastUpdate = 0;
				let lastWidgetUpdate = 0;
				const result = await runPlan({
					ctx,
					plan,
					bridge,
					artifacts,
					signal,
					onProgress: (update) => {
						const now = Date.now();
						if (now - lastWidgetUpdate >= 250) {
							lastWidgetUpdate = now;
							refreshWidget(ctx, settings, update);
						}
						if (now - lastUpdate < 750) return;
						lastUpdate = now;
						onUpdate?.({
							content: [{ type: "text" as const, text: progressText(update) }],
							details: { progress: update },
						});
					},
				});

				if (planNumber !== undefined) {
					store.update(planNumber, {
						status: planStatusFromRun(result.status),
						runId: result.runId,
						runStatus: result.status,
						lastRunAt: new Date().toISOString(),
						lastNodes: result.nodes.map((node) => ({ id: node.id, status: node.status, attempts: node.attempts })),
					});
				}
				refreshWidget(ctx, settings);

				const report = buildRunReport(result);
				notify(
					ctx,
					`Orchestration ${result.status}: ${result.nodes.filter((node) => node.status === "done").length}/${result.nodes.length} nodes done.`,
					result.status === "complete" ? "info" : "warning",
				);
				return {
					content: [{ type: "text" as const, text: report }],
					details: {
						runId: result.runId,
						status: result.status,
						planNumber: result.planNumber,
						artifactDir: result.artifactDir,
						nodes: result.nodes.map((node) => ({
							id: node.id,
							title: node.title,
							status: node.status,
							attempts: node.attempts,
							agentId: node.agentId,
							branch: node.branch,
							audit: node.lastAudit?.approved ?? null,
							error: node.error,
						})),
					},
					...(usageForToolResult(result.usage) ? { usage: usageForToolResult(result.usage) } : {}),
				};
			} catch (error) {
				if (planNumber !== undefined) {
					store.update(planNumber, { status: "failed", runStatus: "error", lastRunAt: new Date().toISOString() });
				}
				refreshWidget(ctx, settings);
				return {
					content: [
						{
							type: "text" as const,
							text: `Orchestration failed to start: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: { error: true },
					isError: true,
				};
			} finally {
				bridge.close();
			}
		},
	});
}

function planDetails(store: PlanStore, plan: PlanRecord): string {
	return [
		`Plan #${plan.number} — ${plan.title}`,
		`Status: ${plan.status}${plan.runStatus ? ` (run ${plan.runStatus})` : ""}`,
		`Objective: ${plan.objective}`,
		`Artifact: ${store.dir(plan.number)}`,
		...(plan.runId ? [`Run: ${plan.runId}`] : []),
		"",
		"Nodes:",
		...plan.nodes.map((node) => {
			const last = plan.lastNodes?.find((candidate) => candidate.id === node.id);
			const outcome = last ? `[${last.status}${last.attempts > 1 ? ` ×${last.attempts}` : ""}] ` : "";
			return `- ${outcome}${node.id}: ${node.title ?? node.id}${node.deps?.length ? ` (deps: ${node.deps.join(", ")})` : ""}`;
		}),
	].join("\n");
}

export default function orchestrator(pi: ExtensionAPI) {
	pi.registerTool(createPlanTool(pi));
	pi.registerTool(createRunTool(pi));

	pi.on("session_start", (_event, ctx) => {
		if (childSession()) return;
		const settings = loadSettings(ctx.cwd);
		widget.configure(settings.widget);
		widget.attach(ctx);
		refreshWidget(ctx, settings);
	});

	pi.on("session_shutdown", () => {
		widget.dispose();
	});

	pi.registerCommand("orchestrator-plan", {
		description: "Refine a draft into a numbered plan (does not execute)",
		handler: async (_args, ctx) => {
			const draft = (_args ?? "").trim();
			if (!draft) {
				notify(ctx, "Usage: /orchestrator-plan <description of the work>", "warning");
				return;
			}
			pi.sendMessage(
				{ customType: PLAN_MESSAGE, content: buildPlanningPrompt(draft), display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			notify(ctx, "Planning turn started. The plan will get a number; run it with /orchestrator-resume <n>.");
		},
	});

	pi.registerCommand("orchestrator-plan-clear", {
		description: "Delete all stored plans (run artifacts are kept)",
		handler: async (_args, ctx) => {
			if (childSession()) {
				notify(ctx, "Plan storage is unavailable inside a subagent.", "warning");
				return;
			}
			const settings = loadSettings(ctx.cwd);
			const store = storeFor(ctx, settings);
			const plans = store.list();
			if (plans.length === 0) {
				notify(ctx, "No plans to clear.");
				return;
			}
			const forced = /(?:^|\s)(?:--yes|-y)(?:\s|$)/i.test(_args ?? "");
			if (!forced) {
				if (!ctx.hasUI) {
					notify(
						ctx,
						`Refusing to delete ${plans.length} plan(s) without confirmation. Re-run with --yes.`,
						"warning",
					);
					return;
				}
				const confirmed = await ctx.ui.confirm(
					`Delete all ${plans.length} plan(s)?`,
					"Removes every plan.json/plan.md under .pi/orchestrator/plans. Run artifacts under runs/ are kept. This cannot be undone.",
				);
				if (!confirmed) {
					notify(ctx, "Cancelled; plans unchanged.");
					return;
				}
			}
			const removed = store.clearAll();
			refreshWidget(ctx, settings);
			notify(ctx, `Cleared ${removed} plan${removed === 1 ? "" : "s"}.`);
		},
	});

	pi.registerCommand("orchestrator-resume", {
		description: "Execute a stored plan by number (defaults to the newest resumable plan)",
		handler: async (_args, ctx) => {
			if (childSession()) {
				notify(ctx, "Orchestration is unavailable inside a subagent.", "warning");
				return;
			}
			const settings = loadSettings(ctx.cwd);
			const store = storeFor(ctx, settings);
			const { plan, error } = resolveResumeTarget(store.list(), _args ?? "");
			if (!plan) {
				notify(ctx, error ?? "No resumable plan.", "warning");
				return;
			}
			if (plan.status === "running") {
				notify(ctx, `Plan #${plan.number} is already running. Abort the current run before resuming it.`, "warning");
				return;
			}
			pi.sendMessage(
				{ customType: RESUME_MESSAGE, content: buildResumePrompt(plan), display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			notify(ctx, `Resuming plan #${plan.number} — ${plan.title}.`);
		},
	});

	pi.registerCommand("orchestrator-plan-list", {
		description: "List orchestration plans with number, title and status",
		handler: async (_args, ctx) => {
			const settings = loadSettings(ctx.cwd);
			const store = storeFor(ctx, settings);
			notify(ctx, formatPlanList(store.list()));
		},
	});

	pi.registerCommand("orchestrator-status", {
		description: "Show a plan's details (latest plan) or the latest run",
		handler: async (_args, ctx) => {
			const settings = loadSettings(ctx.cwd);
			const store = storeFor(ctx, settings);
			const raw = (_args ?? "").trim();
			if (/^\d+$/.test(raw)) {
				const plan = store.get(Number(raw));
				if (!plan) {
					notify(ctx, `Plan #${raw} not found. Use /orchestrator-plan-list.`, "warning");
					return;
				}
				notify(ctx, planDetails(store, plan));
				return;
			}
			const plans = store.list();
			const latest = plans[plans.length - 1];
			if (latest) {
				notify(ctx, planDetails(store, latest));
				return;
			}
			const run = readLatestRun(ctx.cwd, settings.artifactsRoot);
			if (!run) {
				notify(ctx, "No plans or runs recorded in this project yet.");
				return;
			}
			notify(
				ctx,
				[
					`Run: ${run.runId} (${run.status})`,
					`Plan: ${run.planNumber === undefined ? "(ad-hoc)" : `#${run.planNumber}`}`,
					`Objective: ${run.objective}`,
					`Artifacts: ${run.artifactDir}`,
					"",
					...run.nodes.map((node) => `- [${node.status}] ${node.id}: ${node.title}`),
				].join("\n"),
			);
		},
	});

	pi.registerCommand("orchestrator-settings", {
		description: "Show resolved pi-goal-orchestrator settings",
		handler: async (_args, ctx) => {
			const settings = loadSettings(ctx.cwd);
			notify(ctx, JSON.stringify(settings, null, 2));
		},
	});
}
