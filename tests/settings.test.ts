import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { applySettingsLayer, DEFAULT_SETTINGS, projectSettingsPath, writeProjectSettings } from "../src/settings.ts";

test("defaults are valid", () => {
	assert.equal(DEFAULT_SETTINGS.maxConcurrent, 3);
	assert.equal(DEFAULT_SETTINGS.audit.enabled, true);
	assert.equal(DEFAULT_SETTINGS.failFast, true);
	assert.equal(DEFAULT_SETTINGS.widget, true);
	assert.equal(DEFAULT_SETTINGS.artifactsRoot, path.join(".pi", "orchestrator"));
});

test("layers merge and validate values", () => {
	const merged = applySettingsLayer(DEFAULT_SETTINGS, {
		maxConcurrent: 5,
		failFast: false,
		audit: { enabled: false, model: "p/m", thinkingLevel: "low" },
		worker: { model: "cheap/model" },
		defaultTimeoutSeconds: 900,
		defaultMaxAttempts: 4,
		widget: false,
	});
	assert.equal(merged.maxConcurrent, 5);
	assert.equal(merged.failFast, false);
	assert.equal(merged.audit.enabled, false);
	assert.equal(merged.audit.model, "p/m");
	assert.equal(merged.audit.thinkingLevel, "low");
	assert.equal(merged.worker.model, "cheap/model");
	assert.equal(merged.defaultTimeoutSeconds, 900);
	assert.equal(merged.defaultMaxAttempts, 4);
	assert.equal(merged.widget, false);
});

test("invalid values are ignored instead of corrupting settings", () => {
	const merged = applySettingsLayer(DEFAULT_SETTINGS, {
		maxConcurrent: 999,
		failFast: "yes",
		audit: { thinkingLevel: "extreme" },
		defaultTimeoutSeconds: -1,
	});
	assert.equal(merged.maxConcurrent, DEFAULT_SETTINGS.maxConcurrent);
	assert.equal(merged.failFast, DEFAULT_SETTINGS.failFast);
	assert.equal(merged.audit.thinkingLevel, undefined);
	assert.equal(merged.defaultTimeoutSeconds, DEFAULT_SETTINGS.defaultTimeoutSeconds);
});

test("project layer wins over global without mutating the base", () => {
	const global = applySettingsLayer(DEFAULT_SETTINGS, { maxConcurrent: 2, audit: { model: "global/m" } });
	const project = applySettingsLayer(global, { audit: { model: "project/m" } });
	assert.equal(project.audit.model, "project/m");
	assert.equal(project.maxConcurrent, 2);
	assert.equal(global.audit.model, "global/m");
	assert.notEqual(project, global);
});

test("writeProjectSettings merges atomically and preserves unknown keys", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-settings-"));
	try {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(
			projectSettingsPath(cwd),
			JSON.stringify({ widget: false, maxConcurrent: 4, fromNewerBuild: { keep: true } }),
		);
		const updated = writeProjectSettings(cwd, { widget: true });
		assert.equal(updated.widget, true);
		assert.equal(updated.maxConcurrent, 4);
		const raw = JSON.parse(fs.readFileSync(projectSettingsPath(cwd), "utf8")) as Record<string, unknown>;
		assert.deepEqual(raw.fromNewerBuild, { keep: true });
		assert.equal(fs.readdirSync(path.join(cwd, ".pi")).some((name) => name.includes(".tmp-")), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
