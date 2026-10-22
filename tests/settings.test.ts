import assert from "node:assert/strict";
import { test } from "node:test";
import { applySettingsLayer, DEFAULT_SETTINGS } from "../src/settings.ts";

test("defaults are valid", () => {
	assert.equal(DEFAULT_SETTINGS.maxConcurrent, 3);
	assert.equal(DEFAULT_SETTINGS.audit.enabled, true);
	assert.equal(DEFAULT_SETTINGS.failFast, true);
});

test("layers merge and validate values", () => {
	const merged = applySettingsLayer(DEFAULT_SETTINGS, {
		maxConcurrent: 5,
		failFast: false,
		audit: { enabled: false, model: "p/m", thinkingLevel: "low" },
		worker: { model: "cheap/model" },
		defaultTimeoutSeconds: 900,
		defaultMaxAttempts: 4,
	});
	assert.equal(merged.maxConcurrent, 5);
	assert.equal(merged.failFast, false);
	assert.equal(merged.audit.enabled, false);
	assert.equal(merged.audit.model, "p/m");
	assert.equal(merged.audit.thinkingLevel, "low");
	assert.equal(merged.worker.model, "cheap/model");
	assert.equal(merged.defaultTimeoutSeconds, 900);
	assert.equal(merged.defaultMaxAttempts, 4);
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
