/**
 * Independent node auditor.
 *
 * This is intentionally the same shape as pi-goal-x's completion auditor: a
 * fresh in-memory pi session with an empty resource loader and read-only tools.
 * It receives the worker's claim only as untrusted evidence and must inspect
 * the workspace itself.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { buildAuditorPrompt, excerpt, parseAuditDecision } from "./prompt.ts";
import type { NodeAuditResult, PlanNode } from "./types.ts";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];

function makeIsolatedLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () =>
			[
				"You are a read-only auditor in an isolated pi session.",
				"Verify real artifacts. Never modify files. A worker's report is a claim, not evidence.",
			].join("\n"),
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

/**
 * Resolve a configured model. A provider/model pair is exact; a bare id/name
 * must match exactly one available model.
 */
export function resolveAuditModel(
	ctx: ExtensionContext,
	modelSpec?: string,
): { model: Model<any> | undefined; error?: string } {
	if (!modelSpec) return { model: ctx.model as unknown as Model<any> };
	const slash = modelSpec.indexOf("/");
	try {
		if (slash > 0) {
			const model = ctx.modelRegistry.find(modelSpec.slice(0, slash), modelSpec.slice(slash + 1));
			return model
				? { model: model as unknown as Model<any> }
				: { model: undefined, error: `Auditor model not found: ${modelSpec}` };
		}
		const matches = ctx.modelRegistry
			.getAvailable()
			.filter((model) => model.id === modelSpec || model.name === modelSpec);
		if (matches.length === 1) return { model: matches[0] as unknown as Model<any> };
		return { model: undefined, error: `Auditor model is ${matches.length === 0 ? "unavailable" : "ambiguous"}: ${modelSpec}` };
	} catch (error) {
		return { model: undefined, error: error instanceof Error ? error.message : String(error) };
	}
}

export interface AuditArgs {
	ctx: ExtensionContext;
	objective: string;
	node: PlanNode;
	workerResult: string;
	artifactsDir: string;
	attempt: number;
	modelSpec?: string;
	thinkingLevel?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Worktree branch auto-committed by pi-subagents, when the node was isolated. */
	branch?: string;
	/** Test seam. */
	createSession?: typeof createAgentSession;
}

export async function runNodeAuditor(args: AuditArgs): Promise<NodeAuditResult> {
	const resolved = resolveAuditModel(args.ctx, args.modelSpec);
	if (resolved.error || !resolved.model) {
		return {
			approved: false,
			disapproved: true,
			output: "",
			model: args.modelSpec,
			error: resolved.error ?? "No auditor model available.",
		};
	}

	const outputParts: string[] = [];
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribe: (() => void) | undefined;
	let onAbort: (() => void) | undefined;

	try {
		const createSession = args.createSession ?? createAgentSession;
		const created = await createSession({
			cwd: args.ctx.cwd,
			model: resolved.model,
			thinkingLevel: args.thinkingLevel as never,
			resourceLoader: makeIsolatedLoader(),
			sessionManager: SessionManager.inMemory(args.ctx.cwd),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			tools: READ_ONLY_TOOLS,
		} as Parameters<typeof createAgentSession>[0]);
		session = created.session;

		unsubscribe = session.subscribe((event) => {
			if (event.type !== "message_end") return;
			const message = event.message as { role?: string; content?: Array<{ type?: string; text?: string }> };
			if (message.role !== "assistant") return;
			for (const part of message.content ?? []) {
				if (part.type === "text" && typeof part.text === "string") outputParts.push(part.text);
			}
		});

		onAbort = () => session?.abort();
		args.signal?.addEventListener("abort", onAbort, { once: true });
		if (args.signal?.aborted) onAbort();
		timer = setTimeout(() => {
			timedOut = true;
			session?.abort();
		}, args.timeoutMs);
		timer.unref?.();

		await session.prompt(
			buildAuditorPrompt({
				objective: args.objective,
				node: args.node,
				workerResult: args.workerResult,
				artifactsDir: args.artifactsDir,
				attempt: args.attempt,
				branch: args.branch,
			}),
		);

		const output = outputParts.join("\n\n").trim();
		const stats = session.getSessionStats();
		const usage = {
			input: stats.tokens.input,
			output: stats.tokens.output,
			cacheRead: stats.tokens.cacheRead,
			cacheWrite: stats.tokens.cacheWrite,
			cost: stats.cost,
		};
		if (timedOut || args.signal?.aborted) {
			return {
				approved: false,
				disapproved: true,
				output,
				model: `${resolved.model.provider}/${resolved.model.id}`,
				error: timedOut ? "Audit timed out." : "Audit aborted.",
				usage,
			};
		}
		const decision = parseAuditDecision(output);
		if (!decision.approved && !decision.disapproved) {
			return {
				approved: false,
				disapproved: true,
				output,
				model: `${resolved.model.provider}/${resolved.model.id}`,
				error: "Auditor did not end with <approved/> or <disapproved/>.",
				usage,
			};
		}
		return {
			...decision,
			output,
			model: `${resolved.model.provider}/${resolved.model.id}`,
			usage,
		};
	} catch (error) {
		const aborted = args.signal?.aborted || timedOut;
		return {
			approved: false,
			disapproved: true,
			output: outputParts.join("\n\n").trim(),
			model: args.modelSpec ?? `${resolved.model.provider}/${resolved.model.id}`,
			error: aborted
				? timedOut
					? "Audit timed out."
					: "Audit aborted."
				: excerpt(error instanceof Error ? error.message : String(error), 1000),
		};
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (onAbort) args.signal?.removeEventListener("abort", onAbort);
		unsubscribe?.();
		try {
			session?.dispose?.();
		} catch {
			// best effort
		}
	}
}
