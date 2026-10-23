/**
 * Numbered, resumable plans — the orchestrator's own storage.
 *
 * A plan lives at `<artifactsRoot>/plans/<number>/`:
 *   plan.json  the machine record (nodes, status, run reference)
 *   plan.md    the human-readable artifact
 *
 * Plans are independent of any goal extension. Numbers are stable and
 * allocated from the highest existing plan + 1.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRoot, writeAtomic } from "./fsutil.ts";
import type { PlanNode, PlanNodeSpec } from "./types.ts";

export type PlanStatus = "planned" | "running" | "complete" | "failed" | "aborted";

export interface PlanRecord {
	number: number;
	title: string;
	objective: string;
	/** Original `/orchestrator-plan` draft, when the plan came from a command. */
	description?: string;
	requirements: string[];
	notes?: string;
	status: PlanStatus;
	createdAt: string;
	updatedAt: string;
	nodes: PlanNodeSpec[];
	maxConcurrent?: number;
	failFast?: boolean;
	runId?: string;
	runStatus?: string;
	lastRunAt?: string;
	/** Node outcomes from the last execution, for the status view. */
	lastNodes?: Array<{ id: string; status: string; attempts: number }>;
}

export interface CreatePlanInput {
	title: string;
	objective: string;
	description?: string;
	requirements?: string[];
	notes?: string;
	nodes: PlanNodeSpec[];
	maxConcurrent?: number;
	failFast?: boolean;
}

const STATUSES: ReadonlySet<string> = new Set(["planned", "running", "complete", "failed", "aborted"]);

export function nextPlanNumber(existing: readonly number[]): number {
	const highest = existing.reduce((max, value) => (Number.isInteger(value) && value > max ? value : max), 0);
	return highest + 1;
}

/** One-line list entry: `#3 · Add CSV export · planned · 4 nodes`. */
export function planSummaryLine(plan: PlanRecord): string {
	const nodes = `${plan.nodes.length} node${plan.nodes.length === 1 ? "" : "s"}`;
	return `#${plan.number} · ${plan.title} · ${plan.status} · ${nodes}`;
}

export function formatPlanList(plans: readonly PlanRecord[]): string {
	if (plans.length === 0) return "No plans yet. Use /orchestrator-plan <description> to create one.";
	const lines = ["Orchestrator plans:", ...plans.map((plan) => `  ${planSummaryLine(plan)}`)];
	const running = plans.find((plan) => plan.status === "running");
	if (running) lines.push("", `Running now: #${running.number}. Use /orchestrator-status ${running.number}.`);
	return lines.join("\n");
}

/**
 * Resolve `/orchestrator-resume [number]`.
 * Without a number: the newest plan that is not complete; if every plan is
 * complete, the newest plan. A running plan is returned only when named
 * explicitly, so the default never starts a second execution by accident.
 */
export function resolveResumeTarget(
	plans: readonly PlanRecord[],
	rawArg: string,
): { plan?: PlanRecord; error?: string } {
	const raw = rawArg.trim();
	if (plans.length === 0) return { error: "No plans yet. Use /orchestrator-plan <description> first." };
	if (raw) {
		if (!/^\d+$/.test(raw)) return { error: `"${raw}" is not a plan number. Use /orchestrator-plan-list.` };
		const number = Number(raw);
		const plan = plans.find((candidate) => candidate.number === number);
		if (!plan) return { error: `Plan #${number} not found. Use /orchestrator-plan-list.` };
		return { plan };
	}
	const sorted = [...plans].sort((a, b) => b.number - a.number);
	const actionable = sorted.find((plan) => plan.status !== "complete" && plan.status !== "running");
	const fallback = sorted.find((plan) => plan.status !== "running") ?? sorted[0];
	const plan = actionable ?? fallback;
	return plan ? { plan } : { error: "No resumable plan found." };
}

export function renderPlanMarkdown(plan: PlanRecord): string {
	const lines = [
		`# Plan #${plan.number} — ${plan.title}`,
		"",
		`- Status: ${plan.status}`,
		`- Created: ${plan.createdAt}`,
		`- Updated: ${plan.updatedAt}`,
		`- Nodes: ${plan.nodes.length}`,
		...(plan.runId ? [`- Run: ${plan.runId}${plan.runStatus ? ` (${plan.runStatus})` : ""}`] : []),
		"",
		"## Objective",
		"",
		plan.objective,
	];
	if (plan.description) lines.push("", "## Original draft", "", plan.description);
	if (plan.requirements.length > 0) {
		lines.push("", "## Requirements", "", ...plan.requirements.map((item) => `- ${item}`));
	}
	if (plan.notes) lines.push("", "## Notes", "", plan.notes);
	if (plan.lastNodes?.length) {
		lines.push("", "## Last run", "", ...plan.lastNodes.map((node) => `- [${node.status}] ${node.id} (attempts ${node.attempts})`));
	}
	lines.push("", "## Nodes", "");
	for (const node of plan.nodes) {
		lines.push(
			`### ${node.id} — ${node.title ?? node.id}`,
			"",
			`- Deps: ${node.deps?.length ? node.deps.join(", ") : "(none)"}`,
			`- Audit: ${node.audit === false ? "no" : "yes"}`,
			...(node.outputs?.length ? [`- Outputs: ${node.outputs.join(", ")}`] : []),
			"",
			node.prompt,
			"",
		);
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/** Store a validated node back as a spec (runtime fields never persist). */
export function nodeSpecFromNormalized(node: PlanNode): PlanNodeSpec {
	return {
		id: node.id,
		title: node.title,
		prompt: node.prompt,
		deps: [...node.deps],
		agent_type: node.agentType,
		model: node.model,
		thinking_level: node.thinkingLevel,
		isolation: node.isolation,
		max_turns: node.maxTurns,
		timeout_seconds: Math.round(node.timeoutMs / 1000),
		audit: node.audit,
		max_attempts: node.maxAttempts,
		outputs: [...node.outputs],
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
}

function asNodes(value: unknown): PlanNodeSpec[] | null {
	if (!Array.isArray(value)) return null;
	const nodes: PlanNodeSpec[] = [];
	for (const raw of value) {
		const node = asRecord(raw);
		if (!node) return null;
		const id = asString(node.id);
		const prompt = asString(node.prompt);
		if (!id || !prompt) return null;
		nodes.push({
			...(node as unknown as PlanNodeSpec),
			id,
			prompt,
		});
	}
	return nodes;
}

function normalizeRecord(raw: unknown, fallbackNumber: number): PlanRecord | null {
	const record = asRecord(raw);
	if (!record) return null;
	const title = asString(record.title);
	const objective = asString(record.objective);
	const nodes = asNodes(record.nodes);
	if (!title || !objective || !nodes || nodes.length === 0) return null;
	const number = typeof record.number === "number" && Number.isInteger(record.number) ? record.number : fallbackNumber;
	const status = typeof record.status === "string" && STATUSES.has(record.status) ? (record.status as PlanStatus) : "planned";
	const createdAt = asString(record.createdAt) ?? new Date().toISOString();
	return {
		number,
		title,
		objective,
		description: asString(record.description),
		requirements: asStringArray(record.requirements),
		notes: asString(record.notes),
		status,
		createdAt,
		updatedAt: asString(record.updatedAt) ?? createdAt,
		nodes,
		maxConcurrent: typeof record.maxConcurrent === "number" ? record.maxConcurrent : undefined,
		failFast: typeof record.failFast === "boolean" ? record.failFast : undefined,
		runId: asString(record.runId),
		runStatus: asString(record.runStatus),
		lastRunAt: asString(record.lastRunAt),
		lastNodes: Array.isArray(record.lastNodes)
			? record.lastNodes.flatMap((raw) => {
					const node = asRecord(raw);
					const id = asString(node?.id);
					const status = asString(node?.status);
					if (!id || !status) return [];
					return [{ id, status, attempts: typeof node?.attempts === "number" ? node.attempts : 0 }];
				})
			: undefined,
	};
}

export class PlanStore {
	readonly cwd: string;
	readonly root: string;

	constructor(cwd: string, artifactsRoot: string) {
		this.cwd = cwd;
		this.root = path.join(resolveRoot(cwd, artifactsRoot), "plans");
	}

	dir(number: number): string {
		return path.join(this.root, String(number));
	}

	list(): PlanRecord[] {
		let names: string[] = [];
		try {
			names = fs.readdirSync(this.root);
		} catch {
			return [];
		}
		const plans: PlanRecord[] = [];
		for (const name of names) {
			if (!/^\d+$/.test(name)) continue;
			const number = Number(name);
			try {
				const raw = JSON.parse(fs.readFileSync(path.join(this.root, name, "plan.json"), "utf8")) as unknown;
				const plan = normalizeRecord(raw, number);
				if (plan) plans.push(plan);
			} catch {
				// A malformed plan file is ignored rather than breaking the list.
			}
		}
		return plans.sort((a, b) => a.number - b.number);
	}

	get(number: number): PlanRecord | null {
		return this.list().find((plan) => plan.number === number) ?? null;
	}

	nextNumber(): number {
		return nextPlanNumber(this.list().map((plan) => plan.number));
	}

	create(input: CreatePlanInput): PlanRecord {
		const number = this.nextNumber();
		const now = new Date().toISOString();
		const plan: PlanRecord = {
			number,
			title: input.title,
			objective: input.objective,
			description: input.description,
			requirements: input.requirements ?? [],
			notes: input.notes,
			status: "planned",
			createdAt: now,
			updatedAt: now,
			nodes: input.nodes,
			maxConcurrent: input.maxConcurrent,
			failFast: input.failFast,
		};
		this.write(plan);
		return plan;
	}

	/** Delete every stored plan. Run artifacts stay; returns how many plans were removed. */
	clearAll(): number {
		const count = this.list().length;
		fs.rmSync(this.root, { recursive: true, force: true });
		return count;
	}

	update(number: number, patch: Partial<Omit<PlanRecord, "number" | "createdAt">>): PlanRecord | null {
		const current = this.get(number);
		if (!current) return null;
		const next: PlanRecord = { ...current, ...patch, number, createdAt: current.createdAt };
		this.write(next);
		return next;
	}

	write(plan: PlanRecord): void {
		plan.updatedAt = new Date().toISOString();
		const dir = this.dir(plan.number);
		writeAtomic(path.join(dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
		writeAtomic(path.join(dir, "plan.md"), renderPlanMarkdown(plan));
	}
}
