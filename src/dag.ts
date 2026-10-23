/**
 * Plan validation and the pure DAG primitives.
 *
 * Nothing here does I/O, so readiness, blocking and cycle detection can be
 * tested without spawning a model.
 */

import {
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_MAX_CONCURRENT,
	DEFAULT_MAX_TURNS,
	DEFAULT_TIMEOUT_SECONDS,
	HARD_MAX_CONCURRENT,
	MAX_NODES,
	type NodeStatus,
	type NormalizedPlan,
	type PlanNode,
	type PlanSpec,
	type ThinkingLevel,
} from "./types.ts";

export class PlanValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlanValidationError";
	}
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string, max = 20_000): string {
	if (typeof value !== "string" || !value.trim()) throw new PlanValidationError(`${field} must be a non-empty string.`);
	const text = value.trim();
	if (text.length > max) throw new PlanValidationError(`${field} is too long (max ${max} characters).`);
	return text;
}

function optionalString(value: unknown, field: string, max = 2_000): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new PlanValidationError(`${field} must be a string when set.`);
	// Models often send "" or whitespace for "not set"; treat that as absent.
	const text = value.trim();
	if (!text) return undefined;
	if (text.length > max) throw new PlanValidationError(`${field} is too long (max ${max} characters).`);
	return text;
}

function boundedInt(value: unknown, field: string, min: number, max: number, fallback: number): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw new PlanValidationError(`${field} must be an integer between ${min} and ${max}.`);
	}
	return value;
}

function thinkingLevel(value: unknown, field: string): ThinkingLevel | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new PlanValidationError(`${field} must be a string when set.`);
	const text = value.trim();
	if (!text) return undefined;
	if (!THINKING_LEVELS.has(text as ThinkingLevel)) {
		throw new PlanValidationError(`${field} must be one of ${[...THINKING_LEVELS].join(", ")}.`);
	}
	return text as ThinkingLevel;
}

function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new PlanValidationError(`${field} must be an array of strings.`);
	if (value.length > maxItems) throw new PlanValidationError(`${field} has too many entries (max ${maxItems}).`);
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") throw new PlanValidationError(`${field} entries must be strings.`);
		// Blank entries are treated as absent instead of failing the whole plan.
		const text = item.trim();
		if (!text) continue;
		if (text.length > maxLength) throw new PlanValidationError(`${field} entry is too long (max ${maxLength}).`);
		if (!out.includes(text)) out.push(text);
	}
	return out;
}

function optionalPlanNumber(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_000_000) {
		throw new PlanValidationError("plan_number must be a positive integer.");
	}
	return value;
}

function normalizeNode(raw: unknown, index: number): PlanNode {
	if (!isRecord(raw)) throw new PlanValidationError(`nodes[${index}] must be an object.`);
	const id = nonEmptyString(raw.id, `nodes[${index}].id`, 64);
	if (!ID_RE.test(id)) {
		throw new PlanValidationError(
			`nodes[${index}].id "${id}" is invalid: use 1-64 characters from A-Z, a-z, 0-9, dot, underscore or dash.`,
		);
	}
	const prompt = nonEmptyString(raw.prompt, `nodes[${index}].prompt`, 20_000);
	const deps = stringList(raw.deps, `nodes[${index}].deps`, MAX_NODES, 64) ?? [];
	const audit = raw.audit === undefined || raw.audit === null ? true : raw.audit;
	if (typeof audit !== "boolean") throw new PlanValidationError(`nodes[${index}].audit must be a boolean.`);
	return {
		id,
		title: optionalString(raw.title, `nodes[${index}].title`, 200) ?? id,
		prompt,
		deps,
		agentType: optionalString(raw.agent_type, `nodes[${index}].agent_type`, 100) ?? "general-purpose",
		model: optionalString(raw.model, `nodes[${index}].model`, 200),
		thinkingLevel: thinkingLevel(raw.thinking_level, `nodes[${index}].thinking_level`),
		isolation:
			raw.isolation === undefined || raw.isolation === null || (typeof raw.isolation === "string" && !raw.isolation.trim())
				? undefined
				: raw.isolation === "worktree" || raw.isolation === "off"
					? raw.isolation
					: (() => { throw new PlanValidationError(`nodes[${index}].isolation must be "worktree" or "off".`); })(),
		maxTurns: boundedInt(raw.max_turns, `nodes[${index}].max_turns`, 1, 500, DEFAULT_MAX_TURNS),
		timeoutMs: boundedInt(raw.timeout_seconds, `nodes[${index}].timeout_seconds`, 30, 86_400, DEFAULT_TIMEOUT_SECONDS) * 1000,
		audit,
		maxAttempts: boundedInt(raw.max_attempts, `nodes[${index}].max_attempts`, 1, 5, DEFAULT_MAX_ATTEMPTS),
		outputs: stringList(raw.outputs, `nodes[${index}].outputs`, 40, 500) ?? [],
		status: "pending",
		attempts: 0,
		auditHistory: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, auditInput: 0, auditOutput: 0 },
	};
}

/**
 * Validate and fill defaults. Throws PlanValidationError with a message meant
 * for the model, so a rejected plan can be corrected in the same turn.
 */
export function normalizePlan(spec: PlanSpec, defaultObjective?: string): NormalizedPlan {
	if (!isRecord(spec)) throw new PlanValidationError("The plan must be an object.");
	const rawNodes = spec.nodes;
	if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
		throw new PlanValidationError("nodes must contain at least one task.");
	}
	if (rawNodes.length > MAX_NODES) throw new PlanValidationError(`A plan can contain at most ${MAX_NODES} nodes.`);

	const nodes = rawNodes.map(normalizeNode);
	const byId = new Map<string, PlanNode>();
	for (const node of nodes) {
		if (byId.has(node.id)) throw new PlanValidationError(`Duplicate node id "${node.id}".`);
		byId.set(node.id, node);
	}
	for (const node of nodes) {
		for (const dep of node.deps) {
			if (dep === node.id) throw new PlanValidationError(`Node "${node.id}" cannot depend on itself.`);
			if (!byId.has(dep)) throw new PlanValidationError(`Node "${node.id}" depends on unknown node "${dep}".`);
		}
	}

	const order = topologicalOrder(nodes);
	if (!order) throw new PlanValidationError("The plan contains a dependency cycle.");

	const objective = optionalString(spec.objective, "objective", 20_000) ?? defaultObjective?.trim();
	if (!objective) {
		throw new PlanValidationError("objective is required. Pass the objective explicitly.");
	}

	const auditSpec = isRecord(spec.audit) ? spec.audit : {};
	const auditEnabled = auditSpec.enabled === undefined || auditSpec.enabled === null ? true : auditSpec.enabled;
	if (typeof auditEnabled !== "boolean") throw new PlanValidationError("audit.enabled must be a boolean.");
	for (const node of nodes) {
		if (!auditEnabled) node.audit = false;
	}

	return {
		planNumber: optionalPlanNumber(spec.plan_number),
		objective,
		nodes,
		maxConcurrent: boundedInt(spec.max_concurrent, "max_concurrent", 1, HARD_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT),
		failFast: spec.fail_fast === undefined || spec.fail_fast === null ? true : !!spec.fail_fast,
		audit: {
			enabled: auditEnabled,
			model: optionalString(auditSpec.model, "audit.model", 200),
			thinkingLevel: thinkingLevel(auditSpec.thinking_level, "audit.thinking_level"),
		},
	};
}

/** Kahn's algorithm. Returns null when the graph has a cycle. */
export function topologicalOrder(nodes: readonly PlanNode[]): PlanNode[] | null {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const indegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const node of nodes) {
		indegree.set(node.id, node.deps.length);
		for (const dep of node.deps) {
			const list = dependents.get(dep) ?? [];
			list.push(node.id);
			dependents.set(dep, list);
		}
	}
	const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
	const order: PlanNode[] = [];
	while (queue.length > 0) {
		const id = queue.shift()!;
		const node = byId.get(id);
		if (node) order.push(node);
		for (const next of dependents.get(id) ?? []) {
			const remaining = (indegree.get(next) ?? 1) - 1;
			indegree.set(next, remaining);
			if (remaining === 0) queue.push(next);
		}
	}
	return order.length === nodes.length ? order : null;
}

/** Pending nodes whose dependencies are all done. */
export function readyNodes(nodes: readonly PlanNode[]): PlanNode[] {
	return nodes.filter((node) => {
		if (node.status !== "pending") return false;
		return node.deps.every((dep) => nodes.find((candidate) => candidate.id === dep)?.status === "done");
	});
}

/** Pending nodes that can never run because a dependency failed or was blocked. */
export function blockedNodes(nodes: readonly PlanNode[]): PlanNode[] {
	return nodes.filter((node) => {
		if (node.status !== "pending") return false;
		return node.deps.some((dep) => {
			const status = nodes.find((candidate) => candidate.id === dep)?.status;
			return status === "failed" || status === "blocked" || status === "stopped";
		});
	});
}

const SETTLED: ReadonlySet<NodeStatus> = new Set<NodeStatus>(["done", "failed", "blocked", "stopped"]);

export function isSettled(nodes: readonly PlanNode[]): boolean {
	return nodes.every((node) => SETTLED.has(node.status));
}

export function allDone(nodes: readonly PlanNode[]): boolean {
	return nodes.every((node) => node.status === "done");
}

export function totalUsage(nodes: readonly PlanNode[]) {
	return nodes.reduce(
		(acc, node) => {
			acc.input += node.usage.input + node.usage.auditInput;
			acc.output += node.usage.output + node.usage.auditOutput;
			acc.cacheRead += node.usage.cacheRead;
			acc.cacheWrite += node.usage.cacheWrite;
			acc.cost += node.usage.cost;
			return acc;
		},
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	);
}
