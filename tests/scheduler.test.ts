import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { RunArtifacts, makeRunId } from "../src/artifacts.ts";
import { normalizePlan } from "../src/dag.ts";
import { runPlan } from "../src/scheduler.ts";
import type { SubagentBridge } from "../src/rpc.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NodeAuditResult, PlanNode, PlanSpec, WorkerOutcome } from "../src/types.ts";

interface Spawn {
	agentId: string;
	nodeId: string;
	prompt: string;
}

class FakeBridge {
	readonly spawned: Spawn[] = [];
	readonly stopped: string[] = [];
	private readonly waiters = new Map<string, { resolve: (outcome: WorkerOutcome) => void; reject: (error: Error) => void }>();

	async spawn(input: { type: string; prompt: string; options: { name?: string; description: string } }): Promise<string> {
		const nodeId = (input.options.description ?? "").split("/").pop() ?? "unknown";
		const agentId = `a-${nodeId}-${this.spawned.length}`;
		this.spawned.push({ agentId, nodeId, prompt: input.prompt });
		return agentId;
	}

	waitFor(agentId: string): Promise<WorkerOutcome> {
		return new Promise((resolve, reject) => {
			this.waiters.set(agentId, { resolve, reject });
		});
	}

	async stop(agentId: string): Promise<void> {
		this.stopped.push(agentId);
		const waiter = this.waiters.get(agentId);
		if (waiter) {
			this.waiters.delete(agentId);
			waiter.reject(new Error("stopped"));
		}
	}

	settle(nodeId: string, result: string, status = "completed"): void {
		const spawn = [...this.spawned].reverse().find((item) => item.nodeId === nodeId);
		assert.ok(spawn, `no spawn for ${nodeId}`);
		const waiter = this.waiters.get(spawn.agentId);
		assert.ok(waiter, `no waiter for ${spawn.agentId}`);
		this.waiters.delete(spawn.agentId);
		waiter.resolve({
			agentId: spawn.agentId,
			status,
			result,
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, auditInput: 0, auditOutput: 0 },
		});
	}

	agentsFor(nodeId: string): string[] {
		return this.spawned.filter((item) => item.nodeId === nodeId).map((item) => item.agentId);
	}
}

function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function makeContext(cwd: string): ExtensionContext {
	return { cwd } as ExtensionContext;
}

function makePlan(spec: PlanSpec) {
	return normalizePlan({
		objective: "Ship backend and frontend",
		...(spec as object),
	} as PlanSpec);
}

function makeArtifacts(cwd: string, goalId = "goal-1"): RunArtifacts {
	const root = path.join(cwd, ".pi", "goals", "orchestrator");
	const artifacts = new RunArtifacts(cwd, root, makeRunId(goalId));
	artifacts.writePlan(makePlan({ nodes: [{ id: "x", prompt: "x" }] }));
	return artifacts;
}

function approved(node: PlanNode): NodeAuditResult {
	return { approved: true, disapproved: false, output: `<approved/> ${node.id}` };
}

test("runs the contract first, then backend and frontend in parallel, then verification", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-"));
	const plan = makePlan({
		nodes: [
			{ id: "contract", prompt: "define contract" },
			{ id: "backend", prompt: "backend", deps: ["contract"] },
			{ id: "frontend", prompt: "frontend", deps: ["contract"] },
			{ id: "verify", prompt: "verify", deps: ["backend", "frontend"] },
		],
		max_concurrent: 3,
	} as PlanSpec);
	const bridge = new FakeBridge();
	const artifacts = makeArtifacts(cwd);
	const auditNodes: string[] = [];
	const running = runPlan({
		ctx: makeContext(cwd),
		plan,
		bridge: bridge as unknown as SubagentBridge,
		artifacts,
		runAudit: async ({ node }) => {
			auditNodes.push(node.id);
			return approved(node);
		},
	});

	await tick();
	assert.deepEqual(bridge.spawned.map((item) => item.nodeId), ["contract"]);
	assert.match(bridge.spawned[0]!.prompt, /define contract/);

	bridge.settle("contract", "SUMMARY: contract written\nFILES: docs/c.md");
	await tick();
	await tick();
	assert.deepEqual(bridge.spawned.map((item) => item.nodeId).sort(), ["backend", "contract", "frontend"]);

	bridge.settle("frontend", "SUMMARY: frontend done");
	await tick();
	await tick();
	assert.equal(bridge.agentsFor("verify").length, 0, "verify must wait for both branches");

	bridge.settle("backend", "SUMMARY: backend done");
	await tick();
	await tick();
	assert.equal(bridge.agentsFor("verify").length, 1);

	bridge.settle("verify", "SUMMARY: integrated");
	const result = await running;

	assert.equal(result.status, "complete");
	assert.deepEqual(result.nodes.map((node) => node.status), ["done", "done", "done", "done"]);
	assert.deepEqual(auditNodes.sort(), ["backend", "contract", "frontend", "verify"]);
	assert.equal(result.nodes[0]!.branch, undefined);
	assert.ok(fs.existsSync(path.join(cwd, result.artifactDir, "run.json")));
	assert.ok(fs.existsSync(path.join(cwd, result.artifactDir, "nodes", "backend", "audit-attempt-1.md")));
});

test("a rejected audit retries the node with feedback, then succeeds", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-"));
	const plan = makePlan({
		nodes: [{ id: "backend", prompt: "backend", max_attempts: 2 }],
	} as PlanSpec);
	const bridge = new FakeBridge();
	const artifacts = makeArtifacts(cwd);
	let audits = 0;
	const running = runPlan({
		ctx: makeContext(cwd),
		plan,
		bridge: bridge as unknown as SubagentBridge,
		artifacts,
		runAudit: async ({ node }) => {
			audits += 1;
			if (audits === 1) {
				return { approved: false, disapproved: true, output: "missing tests <disapproved/>" };
			}
			return approved(node);
		},
	});

	await tick();
	bridge.settle("backend", "SUMMARY: first attempt");
	await tick();
	await tick();
	assert.equal(bridge.agentsFor("backend").length, 2, "second attempt should start");
	assert.match(bridge.spawned[1]!.prompt, /missing tests/);
	assert.match(bridge.spawned[1]!.prompt, /attempt 2/);

	bridge.settle("backend", "SUMMARY: second attempt with tests");
	const result = await running;
	assert.equal(result.status, "complete");
	assert.equal(result.nodes[0]!.attempts, 2);
	assert.equal(result.nodes[0]!.auditHistory.length, 2);
});

test("after max attempts, the node fails and dependents are blocked", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-"));
	const plan = makePlan({
		nodes: [
			{ id: "contract", prompt: "contract", max_attempts: 1 },
			{ id: "backend", prompt: "backend", deps: ["contract"] },
		],
	} as PlanSpec);
	const bridge = new FakeBridge();
	const artifacts = makeArtifacts(cwd);
	const running = runPlan({
		ctx: makeContext(cwd),
		plan,
		bridge: bridge as unknown as SubagentBridge,
		artifacts,
		runAudit: async () => ({ approved: false, disapproved: true, output: "not good <disapproved/>" }),
	});

	await tick();
	bridge.settle("contract", "SUMMARY: weak contract");
	const result = await running;

	assert.equal(result.status, "failed");
	assert.equal(result.nodes[0]!.status, "failed");
	assert.equal(result.nodes[1]!.status, "blocked");
	assert.match(result.error ?? "", /Audit rejected/);
	assert.equal(bridge.agentsFor("backend").length, 0);
});

test("missing declared outputs fail the node before the audit", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-"));
	const plan = makePlan({
		nodes: [{ id: "contract", prompt: "contract", outputs: ["docs/missing.md"], max_attempts: 1 }],
	} as PlanSpec);
	const bridge = new FakeBridge();
	const artifacts = makeArtifacts(cwd);
	let audits = 0;
	const running = runPlan({
		ctx: makeContext(cwd),
		plan,
		bridge: bridge as unknown as SubagentBridge,
		artifacts,
		runAudit: async ({ node }) => {
			audits += 1;
			return approved(node);
		},
	});

	await tick();
	bridge.settle("contract", "SUMMARY: forgot the file");
	const result = await running;
	assert.equal(result.status, "failed");
	assert.match(result.nodes[0]!.error ?? "", /Missing expected outputs/);
	assert.equal(audits, 0);
});

test("fail_fast stops scheduling new independent branches", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-"));
	const plan = makePlan({
		nodes: [
			{ id: "a", prompt: "a", max_attempts: 1 },
			{ id: "b", prompt: "b" },
		],
		fail_fast: true,
		max_concurrent: 1,
	} as PlanSpec);
	const bridge = new FakeBridge();
	const artifacts = makeArtifacts(cwd);
	const running = runPlan({
		ctx: makeContext(cwd),
		plan,
		bridge: bridge as unknown as SubagentBridge,
		artifacts,
		runAudit: async () => ({ approved: false, disapproved: true, output: "no <disapproved/>" }),
	});

	await tick();
	bridge.settle("a", "SUMMARY: bad");
	const result = await running;
	assert.equal(result.status, "failed");
	assert.equal(bridge.agentsFor("b").length, 0);
	assert.equal(result.nodes[1]!.status, "pending");
});
