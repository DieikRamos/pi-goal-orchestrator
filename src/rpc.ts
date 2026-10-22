/**
 * Thin client for @tintinweb/pi-subagents' cross-extension RPC.
 *
 * The bus is in-process, so a completion handler can call `consume` before the
 * notification decision is made. We only consume ids this run owns; consuming
 * someone else's result would hide their notification.
 *
 * @see https://github.com/tintinweb/pi-subagents/blob/master/docs/rpc.md
 */

import { randomUUID } from "node:crypto";
import type { WorkerOutcome } from "./types.ts";

export interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

interface RpcReply {
	success?: boolean;
	error?: string;
	data?: unknown;
}

interface AgentCompletionEvent {
	id?: unknown;
	status?: unknown;
	result?: unknown;
	error?: unknown;
	branch?: unknown;
	usage?: {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		cost?: { total?: unknown };
	};
	tokens?: { input?: unknown; output?: unknown; total?: unknown };
}

interface SpawnOptions {
	description: string;
	name?: string;
	model?: string;
	thinkingLevel?: string;
	maxTurns?: number;
	inheritContext: boolean;
	isBackground: boolean;
	isolation?: "worktree" | "off";
}

export class RpcError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcError";
	}
}

export class RpcUnavailableError extends RpcError {
	constructor(message = "pi-subagents is not available in this session (no ping reply).") {
		super(message);
		this.name = "RpcUnavailableError";
	}
}

export class RpcTimeoutError extends RpcError {
	constructor(message: string) {
		super(message);
		this.name = "RpcTimeoutError";
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFromEvent(event: AgentCompletionEvent): WorkerOutcome["usage"] {
	const usage = event.usage;
	return {
		input: number(usage?.input),
		output: number(usage?.output),
		cacheRead: number(usage?.cacheRead),
		cacheWrite: number(usage?.cacheWrite),
		cost: number(usage?.cost?.total),
		auditInput: 0,
		auditOutput: 0,
	};
}

export class SubagentBridge {
	private readonly events: EventBus;
	private readonly offCompleted: () => void;
	private readonly offFailed: () => void;
	private readonly recent = new Map<string, WorkerOutcome>();
	private readonly waiters = new Map<
		string,
		{ resolve: (value: WorkerOutcome) => void; reject: (error: Error) => void; cleanup: () => void }
	>();
	private readonly owned = new Set<string>();
	private closed = false;

	constructor(events: EventBus) {
		this.events = events;
		this.offCompleted = events.on("subagents:completed", (data) => this.onSettled(data, false));
		this.offFailed = events.on("subagents:failed", (data) => this.onSettled(data, true));
	}

	private onSettled(data: unknown, failed: boolean): void {
		const raw = asRecord(data) as AgentCompletionEvent | undefined;
		const id = typeof raw?.id === "string" ? raw.id : undefined;
		if (!id || !raw) return;
		const status = typeof raw.status === "string" ? raw.status : failed ? "error" : "completed";
		const outcome: WorkerOutcome = {
			agentId: id,
			status,
			result: typeof raw.result === "string" ? raw.result : "",
			error: typeof raw.error === "string" ? raw.error : undefined,
			branch: this.lookupBranch(id),
			usage: usageFromEvent(raw),
		};
		// Buffer for a completion that races the spawn reply. Bounded so a long
		// session cannot grow this map without limit.
		this.recent.set(id, outcome);
		if (this.recent.size > 200) {
			const oldest = this.recent.keys().next().value;
			if (oldest) this.recent.delete(oldest);
		}
		if (this.owned.has(id)) {
			// Synchronous on purpose: this is what suppresses the duplicate
			// completion notification (see the pi-subagents RPC reference).
			try {
				this.events.emit("subagents:rpc:consume", { requestId: randomUUID(), agentId: id });
			} catch {
				// Older pi-subagents without consume is fine.
			}
		}
		const waiter = this.waiters.get(id);
		if (waiter) {
			this.waiters.delete(id);
			waiter.cleanup();
			waiter.resolve(outcome);
		}
	}

	private lookupBranch(agentId: string): string | undefined {
		try {
			const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as
				| { getRecord?: (id: string) => { worktreeResult?: { branch?: string } } | undefined }
				| undefined;
			return manager?.getRecord?.(agentId)?.worktreeResult?.branch;
		} catch {
			return undefined;
		}
	}

	private request<T>(channel: string, payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
		const requestId = randomUUID();
		const replyChannel = `${channel}:reply:${requestId}`;
		return new Promise<T>((resolve, reject) => {
			let done = false;
			const timer = setTimeout(() => {
				if (done) return;
				done = true;
				off();
				reject(new RpcTimeoutError(`Timed out waiting for ${channel}.`));
			}, timeoutMs);
			const off = this.events.on(replyChannel, (raw) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				off();
				const reply = asRecord(raw) as RpcReply | undefined;
				if (!reply?.success) {
					reject(new RpcError(typeof reply?.error === "string" ? reply.error : `${channel} failed.`));
					return;
				}
				resolve(reply.data as T);
			});
			try {
				this.events.emit(channel, { requestId, ...payload });
			} catch (error) {
				if (done) return;
				done = true;
				clearTimeout(timer);
				off();
				reject(new RpcError(error instanceof Error ? error.message : String(error)));
			}
		});
	}

	async ping(timeoutMs = 1500): Promise<{ version: number }> {
		const data = await this.request<{ version?: unknown }>("subagents:rpc:ping", {}, timeoutMs);
		return { version: typeof data?.version === "number" ? data.version : 0 };
	}

	async spawn(input: { type: string; prompt: string; options: SpawnOptions }, timeoutMs = 120_000): Promise<string> {
		const data = await this.request<{ id?: unknown }>(
			"subagents:rpc:spawn",
			{ type: input.type, prompt: input.prompt, options: input.options },
			timeoutMs,
		);
		const id = typeof data?.id === "string" ? data.id : undefined;
		if (!id) throw new RpcError("spawn returned no agent id.");
		this.owned.add(id);
		// A very fast agent may have settled before the reply reached us.
		const early = this.recent.get(id);
		if (early) {
			try {
				this.events.emit("subagents:rpc:consume", { requestId: randomUUID(), agentId: id });
			} catch {
				// ignore
			}
		}
		return id;
	}

	/** Resolves when the spawned agent settles. Use the scheduler's signal for cancellation. */
	waitFor(agentId: string, timeoutMs: number, signal?: AbortSignal): Promise<WorkerOutcome> {
		if (this.closed) return Promise.reject(new RpcError("Subagent bridge is closed."));
		const early = this.recent.get(agentId);
		if (early) {
			this.recent.delete(agentId);
			return Promise.resolve(early);
		}
		return new Promise<WorkerOutcome>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				cleanup();
				this.waiters.delete(agentId);
				reject(new RpcError("Orchestration aborted."));
			};
			timer = setTimeout(() => {
				cleanup();
				this.waiters.delete(agentId);
				reject(new RpcTimeoutError(`Agent ${agentId} did not finish within ${Math.round(timeoutMs / 1000)}s.`));
			}, timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}
			this.waiters.set(agentId, { resolve, reject, cleanup });
		});
	}

	/** Best effort: a failed stop is not worth failing the whole run over. */
	async stop(agentId: string): Promise<void> {
		try {
			await this.request("subagents:rpc:stop", { agentId }, 3000);
		} catch {
			// The agent may have finished at the same time.
		}
	}

	close(): void {
		this.closed = true;
		this.offCompleted();
		this.offFailed();
		for (const [id, waiter] of this.waiters) {
			waiter.cleanup();
			waiter.reject(new RpcError("Subagent bridge closed."));
			this.waiters.delete(id);
		}
	}
}
