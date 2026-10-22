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
	/** Append a short orchestration guideline while a pi-goal is focused. */
	injectGoalGuidance: boolean;
	/** Override for artifacts, relative to cwd by default. */
	artifactsRoot: string;
}

export const DEFAULT_SETTINGS: OrchestratorSettings = {
	maxConcurrent: DEFAULT_MAX_CONCURRENT,
	failFast: true,
	audit: { enabled: true },
	worker: {},
	defaultTimeoutSeconds: 1800,
	defaultMaxAttempts: 2,
	injectGoalGuidance: true,
	artifactsRoot: path.join(".pi", "goals", "orchestrator"),
};

const THINKING = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

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
	const guidance = bool(layer.injectGoalGuidance);
	if (guidance !== undefined) next.injectGoalGuidance = guidance;
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
