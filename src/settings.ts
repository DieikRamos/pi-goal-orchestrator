/**
 * Settings are optional. The project file wins over the global file, and tool
 * parameters win over both. Unknown fields are ignored so an older build never
 * fails because a newer one wrote extra keys.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MAX_CONCURRENT, HARD_MAX_CONCURRENT, type ThinkingLevel } from "./types.ts";

export interface OrchestratorSettings {
	maxConcurrent: number;
	failFast: boolean;
	audit: {
		enabled: boolean;
		model?: string;
		thinkingLevel?: ThinkingLevel;
	};
	worker: {
		model?: string;
		thinkingLevel?: ThinkingLevel;
	};
	defaultTimeoutSeconds: number;
	defaultMaxAttempts: number;
	/** Render the plan dashboard widget and status line. */
	widget: boolean;
	/** Root for plans and run artifacts, relative to cwd by default. */
	artifactsRoot: string;
}

export const DEFAULT_SETTINGS: OrchestratorSettings = {
	maxConcurrent: DEFAULT_MAX_CONCURRENT,
	failFast: true,
	audit: { enabled: true },
	worker: {},
	defaultTimeoutSeconds: 1800,
	defaultMaxAttempts: 2,
	widget: true,
	artifactsRoot: path.join(".pi", "orchestrator"),
};

const THINKING = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING.has(value as ThinkingLevel);
}

export interface WorkerArgs {
	/** Show the effective values instead of changing anything. */
	status: boolean;
	/** `null` clears the override so the orchestrator value is inherited. */
	model?: string | null;
	thinking?: ThinkingLevel | null;
	error?: string;
}

/**
 * Parse `/orchestrator-model`:
 *   (none) | status
 *   <provider/model> [off|minimal|low|medium|high|xhigh]
 *   model <provider/model|default> [thinking]
 *   thinking <level|default>
 *   default | reset | inherit
 */
export function parseWorkerArgs(raw: string | undefined): WorkerArgs {
	const tokens = (raw ?? "").trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || tokens[0] === "status") return { status: true };
	const [first, ...rest] = tokens as [string, ...string[]];
	const usage =
		"Usage: /orchestrator-model [model] [thinking] | model <model|default> | thinking <level|default> | default";
	if (first === "default" || first === "reset" || first === "inherit") {
		return rest.length > 0 ? { status: false, error: usage } : { status: false, model: null, thinking: null };
	}
	const parseThinking = (value: string): ThinkingLevel | null | "invalid" => {
		if (value === "default" || value === "inherit" || value === "reset") return null;
		return isThinkingLevel(value) ? value : "invalid";
	};
	if (first === "model") {
		const modelToken = rest[0];
		if (!modelToken) return { status: false, error: usage };
		const model = modelToken === "default" ? null : modelToken;
		if (rest.length === 1) return { status: false, model };
		if (rest.length !== 2) return { status: false, error: usage };
		const thinking = parseThinking(rest[1] as string);
		if (thinking === "invalid") return { status: false, error: `Invalid thinking level "${rest[1]}". ${usage}` };
		return { status: false, model, thinking };
	}
	if (first === "thinking") {
		if (rest.length !== 1) return { status: false, error: usage };
		const thinking = parseThinking(rest[0] as string);
		if (thinking === "invalid") return { status: false, error: `Invalid thinking level "${rest[0]}". ${usage}` };
		return { status: false, thinking };
	}
	if (rest.length > 1) return { status: false, error: usage };
	const thinking = rest.length === 1 ? parseThinking(rest[0] as string) : undefined;
	if (thinking === "invalid") return { status: false, error: `Invalid thinking level "${rest[0]}". ${usage}` };
	return { status: false, model: first, thinking };
}

/** Plugin override wins; otherwise the orchestrator session's own values apply. */
export function resolveSubagentDefaults(
	settings: OrchestratorSettings,
	inherited: { model?: string; thinkingLevel?: ThinkingLevel },
): { model?: string; thinkingLevel?: ThinkingLevel } {
	return {
		model: settings.worker.model ?? inherited.model,
		thinkingLevel: settings.worker.thinkingLevel ?? inherited.thinkingLevel,
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function int(value: unknown, min: number, max: number): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function thinking(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && THINKING.has(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}

/** Merge a parsed JSON layer into a settings object. Exported for tests. */
export function applySettingsLayer(base: OrchestratorSettings, raw: unknown): OrchestratorSettings {
	const layer = asRecord(raw);
	if (!layer) return base;
	const audit = asRecord(layer.audit);
	const worker = asRecord(layer.worker);
	const next: OrchestratorSettings = {
		...base,
		audit: { ...base.audit },
		worker: { ...base.worker },
	};
	const maxConcurrent = int(layer.maxConcurrent, 1, HARD_MAX_CONCURRENT);
	if (maxConcurrent !== undefined) next.maxConcurrent = maxConcurrent;
	const failFast = bool(layer.failFast);
	if (failFast !== undefined) next.failFast = failFast;
	const timeout = int(layer.defaultTimeoutSeconds, 30, 86_400);
	if (timeout !== undefined) next.defaultTimeoutSeconds = timeout;
	const attempts = int(layer.defaultMaxAttempts, 1, 5);
	if (attempts !== undefined) next.defaultMaxAttempts = attempts;
	const widget = bool(layer.widget);
	if (widget !== undefined) next.widget = widget;
	const root = str(layer.artifactsRoot);
	if (root) next.artifactsRoot = root;
	if (audit) {
		const enabled = bool(audit.enabled);
		if (enabled !== undefined) next.audit.enabled = enabled;
		const model = str(audit.model);
		if (model) next.audit.model = model;
		const level = thinking(audit.thinkingLevel);
		if (level) next.audit.thinkingLevel = level;
	}
	if (worker) {
		const model = str(worker.model);
		if (model) next.worker.model = model;
		const level = thinking(worker.thinkingLevel);
		if (level) next.worker.thinkingLevel = level;
	}
	return next;
}

function readJson(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

export function globalSettingsPath(homeDir = os.homedir()): string {
	return path.join(homeDir, ".pi", "agent", "pi-goal-orchestrator.json");
}

export function projectSettingsPath(cwd: string): string {
	return path.join(cwd, ".pi", "pi-goal-orchestrator.json");
}

/** Global layer, then project layer. Missing or malformed files are ignored. */
export function loadSettings(cwd: string, homeDir = os.homedir()): OrchestratorSettings {
	let settings = applySettingsLayer(DEFAULT_SETTINGS, readJson(globalSettingsPath(homeDir)));
	settings = applySettingsLayer(settings, readJson(projectSettingsPath(cwd)));
	return settings;
}

/**
 * Merge a patch into the project settings file, preserving keys this build
 * does not know about (a newer version may have written them). Atomic: a crash
 * mid-write cannot leave a truncated JSON file behind.
 */
export function writeProjectSettings(cwd: string, patch: Record<string, unknown>): OrchestratorSettings {
	const file = projectSettingsPath(cwd);
	const current = readJson(file);
	const merged: Record<string, unknown> =
		current && typeof current === "object" && !Array.isArray(current)
			? { ...(current as Record<string, unknown>) }
			: {};
	for (const [key, value] of Object.entries(patch)) {
		const current = merged[key];
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			current &&
			typeof current === "object" &&
			!Array.isArray(current)
		) {
			// One level deep is enough for `audit` and `worker`; undefined removes a key.
			merged[key] = { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) };
		} else {
			merged[key] = value;
		}
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	fs.renameSync(temp, file);
	return loadSettings(cwd);
}
