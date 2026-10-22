import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcError, RpcTimeoutError, SubagentBridge, type EventBus } from "../src/rpc.ts";

class FakeBus implements EventBus {
	readonly handlers = new Map<string, Set<(data: unknown) => void>>();
	readonly emitted: Array<{ event: string; data: unknown }> = [];

	on(event: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(event) ?? new Set();
		set.add(handler);
		this.handlers.set(event, set);
		return () => set.delete(handler);
	}

	emit(event: string, data: unknown): void {
		this.emitted.push({ event, data });
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
	}

	handle(event: string, handler: (data: unknown) => void): void {
		this.on(event, handler);
	}

	find(event: string): Array<{ event: string; data: unknown }> {
		return this.emitted.filter((item) => item.event === event);
	}
}

test("ping resolves through the reply channel", async () => {
	const bus = new FakeBus();
	bus.handle("subagents:rpc:ping", (raw) => {
		const { requestId } = raw as { requestId: string };
		bus.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 2 } });
	});
	const bridge = new SubagentBridge(bus);
	try {
		assert.deepEqual(await bridge.ping(100), { version: 2 });
	} finally {
		bridge.close();
	}
});

test("spawn + completion consume the result and resolve waitFor", async () => {
	const bus = new FakeBus();
	bus.handle("subagents:rpc:spawn", (raw) => {
		const { requestId } = raw as { requestId: string };
		bus.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id: "a1" } });
	});
	const bridge = new SubagentBridge(bus);
	try {
		const id = await bridge.spawn({
			type: "general-purpose",
			prompt: "do it",
			options: { description: "test", inheritContext: false, isBackground: true },
		});
		assert.equal(id, "a1");
		const waited = bridge.waitFor("a1", 1000);
		bus.emit("subagents:completed", {
			id: "a1",
			status: "completed",
			result: "done",
			usage: { input: 10, output: 5, cost: { total: 0.02 } },
		});
		const outcome = await waited;
		assert.equal(outcome.result, "done");
		assert.equal(outcome.usage.input, 10);
		assert.equal(outcome.usage.cost, 0.02);
		assert.equal(bus.find("subagents:rpc:consume").length, 1);
	} finally {
		bridge.close();
	}
});

test("a completion that races the spawn reply is still consumed and returned", async () => {
	const bus = new FakeBus();
	bus.handle("subagents:rpc:spawn", (raw) => {
		const { requestId } = raw as { requestId: string };
		// Completion arrives before the spawn reply.
		bus.emit("subagents:completed", { id: "fast", status: "completed", result: "early" });
		bus.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id: "fast" } });
	});
	const bridge = new SubagentBridge(bus);
	try {
		const id = await bridge.spawn({
			type: "general-purpose",
			prompt: "fast",
			options: { description: "test", inheritContext: false, isBackground: true },
		});
		const outcome = await bridge.waitFor(id, 1000);
		assert.equal(outcome.result, "early");
		assert.equal(bus.find("subagents:rpc:consume").length, 1);
	} finally {
		bridge.close();
	}
});

test("does not consume completions owned by another caller", async () => {
	const bus = new FakeBus();
	const bridge = new SubagentBridge(bus);
	try {
		bus.emit("subagents:completed", { id: "other", status: "completed", result: "not ours" });
		assert.equal(bus.find("subagents:rpc:consume").length, 0);
	} finally {
		bridge.close();
	}
});

test("failed events reject the wait with a failed outcome", async () => {
	const bus = new FakeBus();
	bus.handle("subagents:rpc:spawn", (raw) => {
		const { requestId } = raw as { requestId: string };
		bus.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id: "a2" } });
	});
	const bridge = new SubagentBridge(bus);
	try {
		await bridge.spawn({
			type: "general-purpose",
			prompt: "x",
			options: { description: "test", inheritContext: false, isBackground: true },
		});
		const waited = bridge.waitFor("a2", 1000);
		bus.emit("subagents:failed", { id: "a2", status: "error", error: "boom" });
		const outcome = await waited;
		assert.equal(outcome.status, "error");
		assert.equal(outcome.error, "boom");
	} finally {
		bridge.close();
	}
});

test("waitFor times out", async () => {
	const bridge = new SubagentBridge(new FakeBus());
	try {
		await assert.rejects(() => bridge.waitFor("missing", 10), RpcTimeoutError);
	} finally {
		bridge.close();
	}
});

test("spawn error envelopes become RpcError", async () => {
	const bus = new FakeBus();
	bus.handle("subagents:rpc:spawn", (raw) => {
		const { requestId } = raw as { requestId: string };
		bus.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: false, error: "No active session" });
	});
	const bridge = new SubagentBridge(bus);
	try {
		await assert.rejects(
			() =>
				bridge.spawn({
					type: "general-purpose",
					prompt: "x",
					options: { description: "test", inheritContext: false, isBackground: true },
				}),
			(error: unknown) => error instanceof RpcError && /No active session/.test(error.message),
		);
	} finally {
		bridge.close();
	}
});
