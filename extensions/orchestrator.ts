/**
 * pi-goal-orchestrator
 *
 * A companion extension for pi-goal-x: the focused goal session can hand a DAG
 * of independent work to pi-subagents, then receive one compact report. Each
 * node is executed in its own context and independently audited before it can
 * unblock its dependents.
 */

import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { makeRunId, readLatestRun, RunArtifacts } from "../src/artifacts.ts";
import {
	type AutoStartDecision,
	autoStartMessage,
	decideAutoStart,
	listRuns,
	objectiveSignature,
	parseModeArgs,
	readAutoMarker,
	writeAutoMarker,
} from "../src/auto.ts";
import { PlanValidationError, normalizePlan } from "../src/dag.ts";
import { readFocusedGoal } from "../src/goal.ts";
import { nodesFromGoalTasks } from "../src/tasks.ts";
import { buildRunReport } from "../src/prompt.ts";
import { SubagentBridge, RpcError } from "../src/rpc.ts";
import { runPlan } from "../src/scheduler.ts";
import { loadSettings, writeProjectSettings, type OrchestratorSettings } from "../src/settings.ts";
import type { PlanAuditSpec, PlanNodeSpec, PlanSpec, RunProgress } from "../src/types.ts";

const TOOL_NAME = "run_goal_plan";
const AUTO_CUSTOM_TYPE = "pi-goal-orchestrator:auto";

/** A run_goal_plan call is executing in this session; settle hooks must not start another. */
let runInFlight = false;
/** Signatures already nudged in this runtime, even if the marker file could not be written. */
const queuedSignatures = new Set<string>();

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
		`Goal orchestration ${progress.runId}`,
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

function createPlanTool(pi: ExtensionAPI) {
	return defineTool({
	name: TOOL_NAME,
	label: "Run Goal Plan",
	description:
		"Execute a dependency graph of subagents for the focused goal. Each node runs in its own context and is independently audited before dependent nodes start. Pass nodes for a custom DAG, or omit them (or pass tasks: true) to run the focused goal's pending tasks as an audited chain. Goal work must happen here, not inline.",
	promptSnippet: "Run a DAG of audited subagents for the focused goal.",
	promptGuidelines: [
		"Every unit of goal work must run through run_goal_plan; this session only plans, reviews and reports.",
		'When the focused goal already has a task list, call run_goal_plan with { "tasks": true } instead of inventing a DAG.',
		"Plan nodes must be small and have explicit dependencies. A node only unblocks dependents after its independent audit approves.",
		"For a custom DAG, put the contract/interface node first, then parallel implementation nodes, then an integrated verification node.",
		"Use cheaper models per node when the task is mechanical; reserve the strong model for planning and ambiguous work.",
		"After the run, inspect the compact report and artifacts, update the goal tasks, then request goal completion; the pi-goal-x auditor remains the final authority.",
	],
	parameters: Type.Object(
		{
			goal_id: Type.Optional(Type.String({ description: "pi-goal id. Defaults to the focused goal." })),
			objective: Type.Optional(
				Type.String({ description: "Goal objective. Defaults to the focused pi-goal objective." }),
			),
			tasks: Type.Optional(
				Type.Boolean({
					description:
						"Derive nodes from the focused goal's pending tasks (sequential chain + integrated verification). Mutually exclusive with nodes. Defaults to true when nodes is omitted.",
				}),
			),
			nodes: Type.Optional(
				Type.Array(
					Type.Object(
						{
							id: Type.String({ description: "Stable short id, e.g. contract, backend, frontend, verify." }),
						title: Type.Optional(Type.String()),
						prompt: Type.String({ description: "Self-contained worker brief. Do not assume parent transcript." }),
						deps: Type.Optional(Type.Array(Type.String(), { description: "Node ids that must finish first." })),
						agent_type: Type.Optional(
							Type.String({ description: "pi-subagents agent type. Defaults to general-purpose." }),
						),
						model: Type.Optional(Type.String({ description: "Worker model, e.g. provider/model-id." })),
						thinking_level: Type.Optional(Type.String()),
						isolation: Type.Optional(
							Type.String({ description: "worktree for parallel writers; off otherwise." }),
						),
						max_turns: Type.Optional(Type.Number()),
						timeout_seconds: Type.Optional(Type.Number()),
						audit: Type.Optional(Type.Boolean({ description: "Independent audit for this node. Default true." })),
						max_attempts: Type.Optional(Type.Number({ description: "Worker/audit attempts, 1-5. Default 2." })),
						outputs: Type.Optional(
							Type.Array(Type.String(), { description: "Expected paths; checked after the worker finishes." }),
						),
					},
					{ additionalProperties: false },
				),
					{ minItems: 1, maxItems: 32 },
				),
			),
			max_concurrent: Type.Optional(Type.Number({ description: "Parallel worker slots. Default 3, max 16." })),
			fail_fast: Type.Optional(
				Type.Boolean({ description: "Stop scheduling new nodes after a failure. Default true." }),
			),
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
				content: [
					{
						type: "text" as const,
						text: "run_goal_plan is disabled inside a subagent. Orchestrate from the parent goal session.",
					},
				],
				details: { error: true },
				isError: true,
			};
		}

		const settings = loadSettings(ctx.cwd);
		const focused = readFocusedGoal(ctx);

		const explicitNodes = (params.nodes ?? []) as PlanNodeSpec[];
		if (params.tasks === true && explicitNodes.length > 0) {
			return {
				content: [{ type: "text" as const, text: "Plan rejected: pass either nodes or tasks: true, not both." }],
				details: { error: true },
				isError: true,
			};
		}
		let nodes = explicitNodes;
		if (nodes.length === 0) {
			if (!focused) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Plan rejected: no nodes and no focused goal. Focus a pi-goal or pass an explicit DAG.",
						},
					],
					details: { error: true },
					isError: true,
				};
			}
			nodes = nodesFromGoalTasks(focused);
		}

		const spec: PlanSpec = {
			goal_id: params.goal_id ?? focused?.id,
			objective: params.objective ?? focused?.objective,
			nodes,
			max_concurrent: params.max_concurrent,
			fail_fast: params.fail_fast,
			audit: params.audit as PlanAuditSpec | undefined,
		};

		let plan;
		try {
			plan = normalizePlan(applyDefaults(spec, settings));
		} catch (error) {
			const message = error instanceof PlanValidationError ? error.message : String(error);
			return {
				content: [{ type: "text" as const, text: `Plan rejected: ${message}` }],
				details: { error: true },
				isError: true,
			};
		}

		const bridge = new SubagentBridge(pi.events);
		try {
			try {
				await bridge.ping(3000);
			} catch (error) {
				throw new RpcError(
					`pi-subagents is not available in this session (${error instanceof Error ? error.message : String(error)}). Install npm:@tintinweb/pi-subagents or enable it for this project.`,
				);
			}

			const runId = makeRunId(plan.goalId);
			const artifacts = new RunArtifacts(ctx.cwd, settings.artifactsRoot, runId);
			artifacts.writePlan(plan);
			notify(ctx, `Goal orchestration started: ${plan.nodes.length} nodes, ${plan.maxConcurrent} parallel.`);

			let lastUpdate = 0;
			runInFlight = true;
			const result = await runPlan({
				ctx,
				plan,
				bridge,
				artifacts,
				signal,
				onProgress: (update) => {
					const now = Date.now();
					if (now - lastUpdate < 750) return;
					lastUpdate = now;
					onUpdate?.({
						content: [{ type: "text" as const, text: progressText(update) }],
						details: { progress: update },
					});
				},
			});

			const report = buildRunReport(result);
			notify(
				ctx,
				`Goal orchestration ${result.status}: ${result.nodes.filter((node) => node.status === "done").length}/${result.nodes.length} nodes done.`,
				result.status === "complete" ? "info" : "warning",
			);
			return {
				content: [{ type: "text" as const, text: report }],
				details: {
					runId: result.runId,
					status: result.status,
					artifactDir: result.artifactDir,
					goalId: result.goalId,
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
			return {
				content: [
					{
						type: "text" as const,
						text: `Goal orchestration failed to start: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				details: { error: true },
				isError: true,
			};
		} finally {
			runInFlight = false;
			bridge.close();
		}
	},
	});
}

function orchestrationGuideline(goal: NonNullable<ReturnType<typeof readFocusedGoal>>, runs: ReturnType<typeof listRuns>): string {
	const signature = objectiveSignature(goal.objective);
	const orchestrated = runs.some(
		(run) => run.goalId === goal.id && objectiveSignature(run.objective) === signature,
	);
	if (orchestrated) {
		return (
			"Goal orchestration: this goal objective already has an orchestration run. Read its report and artifacts " +
			"before starting new work; do not re-plan the same objective unless the user asks."
		);
	}
	return (
		"Goal orchestration: this active goal has no orchestration run yet. Before doing any goal work, your first " +
		'action must be run_goal_plan. If the goal has a task list, call it with { "tasks": true }; otherwise pass ' +
		"an explicit DAG (contract/interface first, then parallel branches, then integrated verification). " +
		"write/edit are blocked until the goal has a run. Keep this context for planning and review; do not execute " +
		"worker-sized tasks inline."
	);
}

function evaluateAutoStart(
	ctx: ExtensionContext,
	settings: OrchestratorSettings,
	goal: NonNullable<ReturnType<typeof readFocusedGoal>>,
	reason: string,
	force: boolean,
): AutoStartDecision {
	const decision = decideAutoStart({
		goal,
		enabled: settings.autoOrchestrate,
		runs: listRuns(ctx.cwd, settings.artifactsRoot),
		marker: readAutoMarker(ctx.cwd, settings.artifactsRoot, goal.id),
		inFlight: runInFlight,
		force,
	});
	if (!decision.start) return decision;
	const queueKey = `${goal.id}:${decision.signature}`;
	if (!force && queuedSignatures.has(queueKey)) {
		return { ...decision, start: false, reason: "planning already queued in this session" };
	}
	queuedSignatures.add(queueKey);
	try {
		writeAutoMarker(ctx.cwd, settings.artifactsRoot, {
			goalId: goal.id,
			signature: decision.signature,
			triggeredAt: new Date().toISOString(),
			reason,
		});
	} catch {
		// The in-memory signature guard still prevents a loop in this session.
	}
	return decision;
}

export default function goalOrchestrator(pi: ExtensionAPI) {
	pi.registerTool(createPlanTool(pi));

	pi.on("before_agent_start", (_event, ctx) => {
		if (childSession()) return;
		const settings = loadSettings(ctx.cwd);
		if (!settings.injectGoalGuidance) return;
		const focused = readFocusedGoal(ctx);
		if (!focused || focused.status !== "active") return;
		const guideline = orchestrationGuideline(focused, listRuns(ctx.cwd, settings.artifactsRoot));
		if (!_event.systemPromptOptions.promptGuidelines.includes(guideline)) {
			_event.systemPromptOptions.promptGuidelines.push(guideline);
		}
	});

	// Goal work belongs to subagents. Until the focused goal has an orchestration
	// run, the main session may read, plan and dispatch, but not edit files.
	pi.on("tool_call", (event, ctx) => {
		if (childSession() || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const settings = loadSettings(ctx.cwd);
		if (!settings.enforceSubagentWork) return;
		const goal = readFocusedGoal(ctx);
		if (!goal || goal.status !== "active") return;
		const signature = objectiveSignature(goal.objective);
		const orchestrated = listRuns(ctx.cwd, settings.artifactsRoot).some(
			(run) => run.goalId === goal.id && objectiveSignature(run.objective) === signature,
		);
		if (orchestrated) return;
		return {
			block: true,
			reason:
				"Goal work must run in subagents. Call run_goal_plan first " +
				'({"tasks": true} when the goal already has a task list), then edit only follow-up fixes after the run. ' +
				"Set enforceSubagentWork to false to disable this guard.",
		};
	});

	// A decided goal whose turn settles without a plan is continued exactly once
	// with a hidden planning message. Continuing here (instead of queueing a new
	// run at `agent_settled`) keeps pi-goal-x's own continuation from racing us
	// into a duplicate run for the same objective.
	pi.on("agent_before_settle", (event, ctx) => {
		if (event.outcome !== "completed" || childSession()) return;
		if (event.continue || event.context.pendingMessages.length > 0) return;
		const settings = loadSettings(ctx.cwd);
		if (!settings.autoOrchestrate) return;
		const goal = readFocusedGoal(ctx);
		if (!goal || goal.status !== "active") return;
		const decision = evaluateAutoStart(ctx, settings, goal, "newly decided goal", false);
		if (!decision.start) return;
		notify(ctx, `Goal orchestration auto-started for ${goal.id} (${decision.reason}).`);
		return {
			entries: [
				{
					type: "custom_message" as const,
					customType: AUTO_CUSTOM_TYPE,
					content: autoStartMessage(goal, decision.reason),
					display: false,
				},
			],
			continue: true,
		};
	});

	pi.registerCommand("orchestrate", {
		description: "Plan and execute the focused goal as an audited DAG of subagents now",
		handler: async (_args, ctx) => {
			if (childSession()) {
				notify(ctx, "Orchestration is unavailable inside a subagent.", "warning");
				return;
			}
			const settings = loadSettings(ctx.cwd);
			const goal = readFocusedGoal(ctx);
			if (!goal) {
				notify(ctx, "No focused goal. Create or focus one in pi-goal-x first.", "warning");
				return;
			}
			if (goal.status !== "active") {
				notify(ctx, `Focused goal is ${goal.status ?? "not active"}; resume it before orchestrating.`, "warning");
				return;
			}
			if (!settings.autoOrchestrate) {
				notify(ctx, "autoOrchestrate is disabled; /orchestrate still queues the planning turn.", "info");
			}
			const decision = evaluateAutoStart(ctx, settings, goal, "requested by /orchestrate", true);
			if (!decision.start) {
				notify(ctx, `Nothing to orchestrate: ${decision.reason}.`, "warning");
				return;
			}
			pi.sendMessage(
				{ customType: AUTO_CUSTOM_TYPE, content: autoStartMessage(goal, decision.reason), display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			notify(ctx, `Goal orchestration queued for ${goal.id}.`);
		},
	});

	pi.registerCommand("orchestrate-mode", {
		description:
			"Enable/disable the automatic goal delegation (on|off|toggle|status, optionally scoped: auto|enforce|all)",
		handler: async (_args, ctx) => {
			const { scope, value } = parseModeArgs(_args);
			if (value === "invalid") {
				notify(ctx, "Usage: /orchestrate-mode [auto|enforce|all] [on|off|toggle|status]", "warning");
				return;
			}
			const settings = loadSettings(ctx.cwd);
			if (value === "status") {
				notify(
					ctx,
					[
						`autoOrchestrate: ${settings.autoOrchestrate ? "on" : "off"}`,
						`enforceSubagentWork: ${settings.enforceSubagentWork ? "on" : "off"}`,
					].join("\n"),
				);
				return;
			}
			const current =
				scope === "auto"
					? settings.autoOrchestrate
					: scope === "enforce"
						? settings.enforceSubagentWork
						: settings.autoOrchestrate && settings.enforceSubagentWork;
			const enabled = value === "toggle" ? !current : value === "on";
			const patch =
				scope === "auto"
					? { autoOrchestrate: enabled }
					: scope === "enforce"
						? { enforceSubagentWork: enabled }
						: { autoOrchestrate: enabled, enforceSubagentWork: enabled };
			const updated = writeProjectSettings(ctx.cwd, patch);
			notify(
				ctx,
				[
					`Goal auto-delegation ${scope === "all" ? (enabled ? "enabled" : "disabled") : `${scope} ${enabled ? "on" : "off"}`} (project settings).`,
					`autoOrchestrate: ${updated.autoOrchestrate ? "on" : "off"}, enforceSubagentWork: ${updated.enforceSubagentWork ? "on" : "off"}.`,
				].join("\n"),
			);
		},
	});

	pi.registerCommand("orchestrate-status", {
		description: "Show the latest goal orchestration run and its artifact directory",
		handler: async (_args, ctx) => {
			const settings = loadSettings(ctx.cwd);
			const latest = readLatestRun(ctx.cwd, settings.artifactsRoot);
			if (!latest) {
				notify(ctx, "No goal orchestration run recorded in this project yet.");
				return;
			}
			const lines = [
				`Run: ${latest.runId} (${latest.status})`,
				`Goal: ${latest.goalId ?? "(none)"}`,
				`Objective: ${latest.objective}`,
				`Artifacts: ${latest.artifactDir}`,
				"",
				...latest.nodes.map((node) => `- [${node.status}] ${node.id}: ${node.title}`),
			];
			notify(ctx, lines.join("\n"));
		},
	});

	pi.registerCommand("orchestrate-settings", {
		description: "Show resolved pi-goal-orchestrator settings",
		handler: async (_args, ctx) => {
			const settings = loadSettings(ctx.cwd);
			notify(ctx, JSON.stringify(settings, null, 2));
		},
	});
}
