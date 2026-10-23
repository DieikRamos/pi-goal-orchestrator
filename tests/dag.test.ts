import assert from "node:assert/strict";
import { test } from "node:test";
import {
	PlanValidationError,
	allDone,
	blockedNodes,
	normalizePlan,
	readyNodes,
	topologicalOrder,
} from "../src/dag.ts";

function spec(nodes: unknown[], extra: Record<string, unknown> = {}) {
	return { objective: "Ship the feature", nodes, ...extra } as never;
}

test("normalizes a plan and fills defaults", () => {
	const plan = normalizePlan(
		spec([
			{ id: "contract", prompt: "define the contract", outputs: ["docs/contract.md"] },
			{ id: "backend", prompt: "backend", deps: ["contract"], model: "p/m" },
		]),
	);
	assert.equal(plan.objective, "Ship the feature");
	assert.equal(plan.nodes.length, 2);
	assert.equal(plan.nodes[0]!.audit, true);
	assert.equal(plan.nodes[0]!.maxAttempts, 2);
	assert.equal(plan.nodes[0]!.maxTurns, 80);
	assert.equal(plan.nodes[1]!.model, "p/m");
	assert.equal(plan.nodes[1]!.deps[0], "contract");
	assert.equal(plan.nodes[0]!.status, "pending");
});

test("blank optional node fields are treated as absent, not as invalid", () => {
	const plan = normalizePlan(
		spec([
			{
				id: "write",
				prompt: "write the file",
				title: "",
				model: "",
				thinking_level: "  ",
				agent_type: "",
				isolation: "",
				deps: ["", " "],
				outputs: ["", "out.txt"],
			},
		]),
	);
	const node = plan.nodes[0]!;
	assert.equal(node.model, undefined);
	assert.equal(node.thinkingLevel, undefined);
	assert.equal(node.agentType, "general-purpose");
	assert.equal(node.isolation, undefined);
	assert.deepEqual(node.deps, []);
	assert.deepEqual(node.outputs, ["out.txt"]);
	assert.equal(node.title, "write");
	assert.equal(normalizePlan(spec([{ id: "a", prompt: "a" }], { audit: { model: "  " } })).audit.model, undefined);
	assert.equal(normalizePlan(spec([{ id: "a", prompt: "a", audit: null }])).nodes[0]!.audit, true);
	assert.equal(normalizePlan(spec([{ id: "a", prompt: "a" }], { audit: { enabled: null } })).audit.enabled, true);
	assert.equal(normalizePlan(spec([{ id: "a", prompt: "a" }], { fail_fast: null })).failFast, true);
});

test("rejects a missing dependency", () => {
	assert.throws(
		() => normalizePlan(spec([{ id: "a", prompt: "a", deps: ["missing"] }])),
		(error: unknown) => error instanceof PlanValidationError && /unknown node/.test(error.message),
	);
});

test("rejects a dependency cycle", () => {
	assert.throws(
		() =>
			normalizePlan(
				spec([
					{ id: "a", prompt: "a", deps: ["b"] },
					{ id: "b", prompt: "b", deps: ["a"] },
				]),
			),
		(error: unknown) => error instanceof PlanValidationError && /cycle/.test(error.message),
	);
});

test("rejects duplicate and self dependencies", () => {
	assert.throws(
		() =>
			normalizePlan(
				spec([
					{ id: "a", prompt: "a" },
					{ id: "a", prompt: "b" },
				]),
			),
		/duplicate node id/i,
	);
	assert.throws(
		() => normalizePlan(spec([{ id: "a", prompt: "a", deps: ["a"] }])),
		/cannot depend on itself/,
	);
});

test("requires an objective when none is provided", () => {
	assert.throws(
		() => normalizePlan({ nodes: [{ id: "a", prompt: "a" }] } as never),
		/objective is required/,
	);
});

test("global audit disabled disables every node audit", () => {
	const plan = normalizePlan(
		spec([{ id: "a", prompt: "a" }, { id: "b", prompt: "b", audit: true }], { audit: { enabled: false } }),
	);
	assert.equal(plan.audit.enabled, false);
	assert.ok(plan.nodes.every((node) => !node.audit));
});

test("topological order respects dependencies", () => {
	const plan = normalizePlan(
		spec([
			{ id: "verify", prompt: "v", deps: ["backend", "frontend"] },
			{ id: "backend", prompt: "b", deps: ["contract"] },
			{ id: "frontend", prompt: "f", deps: ["contract"] },
			{ id: "contract", prompt: "c" },
		]),
	);
	const order = topologicalOrder(plan.nodes)!.map((node) => node.id);
	assert.equal(order[0], "contract");
	assert.ok(order.indexOf("verify") > order.indexOf("backend"));
	assert.ok(order.indexOf("verify") > order.indexOf("frontend"));
});

test("ready set fans out only after the contract completes", () => {
	const plan = normalizePlan(
		spec([
			{ id: "contract", prompt: "c" },
			{ id: "backend", prompt: "b", deps: ["contract"] },
			{ id: "frontend", prompt: "f", deps: ["contract"] },
		]),
	);
	assert.deepEqual(readyNodes(plan.nodes).map((node) => node.id), ["contract"]);
	plan.nodes[0]!.status = "done";
	assert.deepEqual(readyNodes(plan.nodes).map((node) => node.id).sort(), ["backend", "frontend"]);
	plan.nodes[1]!.status = "done";
	assert.deepEqual(readyNodes(plan.nodes).map((node) => node.id), ["frontend"]);
	assert.equal(allDone(plan.nodes), false);
});

test("dependents of a failed node are blocked, not ready", () => {
	const plan = normalizePlan(
		spec([
			{ id: "contract", prompt: "c" },
			{ id: "backend", prompt: "b", deps: ["contract"] },
			{ id: "frontend", prompt: "f", deps: ["contract"] },
		]),
	);
	plan.nodes[0]!.status = "failed";
	assert.deepEqual(readyNodes(plan.nodes), []);
	assert.deepEqual(blockedNodes(plan.nodes).map((node) => node.id).sort(), ["backend", "frontend"]);
});

test("bounded settings are validated", () => {
	assert.throws(() => normalizePlan(spec([{ id: "a", prompt: "a" }], { max_concurrent: 99 })), /max_concurrent/);
	assert.throws(() => normalizePlan(spec([{ id: "a", prompt: "a", max_attempts: 9 }])), /max_attempts/);
	assert.throws(() => normalizePlan(spec([{ id: "a", prompt: "a", isolation: "docker" }])), /isolation/);
});
