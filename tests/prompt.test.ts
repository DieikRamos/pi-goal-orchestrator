import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePlan } from "../src/dag.ts";
import {
	buildAuditorPrompt,
	buildRunReport,
	buildWorkerPrompt,
	extractWorkerSummary,
	parseAuditDecision,
} from "../src/prompt.ts";
import type { RunResult } from "../src/types.ts";

function plan() {
	return normalizePlan({
		objective: "Add CSV export",
		nodes: [
			{ id: "contract", title: "Contract", prompt: "Define the contract", outputs: ["docs/c.md"] },
			{ id: "backend", title: "Backend", prompt: "Implement backend", deps: ["contract"], outputs: ["src/b.ts"] },
		],
	});
}

test("audit decision uses only the final marker line", () => {
	assert.deepEqual(parseAuditDecision("Looks good.\n<approved/>"), { approved: true, disapproved: false });
	assert.deepEqual(parseAuditDecision("I would only say <approved/> if...\n<disapproved/>"), {
		approved: false,
		disapproved: true,
	});
	assert.deepEqual(parseAuditDecision("no marker"), { approved: false, disapproved: false });
});

test("worker prompt is self-contained and includes dependency context", () => {
	const p = plan();
	const contract = p.nodes[0]!;
	const backend = p.nodes[1]!;
	contract.result = "The API is GET /export with query q.";
	contract.summary = "GET /export with q";
	contract.branch = "pi-agent-contract";
	const prompt = buildWorkerPrompt({
		objective: p.objective,
		node: backend,
		deps: [contract],
		attempt: 1,
		artifactsDir: ".pi/goals/orchestrator/runs/run-1",
	});
	assert.match(prompt, /Implement backend/);
	assert.match(prompt, /GET \/export/);
	assert.match(prompt, /pi-agent-contract/);
	assert.match(prompt, /Expected outputs/);
	assert.match(prompt, /src\/b\.ts/);
	assert.match(prompt, /Do not create, update, pause, resume, or audit goals/);
});

test("retry prompt carries the auditor feedback", () => {
	const p = plan();
	const node = p.nodes[1]!;
	const prompt = buildWorkerPrompt({
		objective: p.objective,
		node,
		deps: [],
		attempt: 2,
		feedback: "The CSV misses quoted commas.",
		artifactsDir: ".pi/goals/orchestrator/runs/run-1",
	});
	assert.match(prompt, /attempt 2/);
	assert.match(prompt, /quoted commas/);
});

test("auditor prompt treats the worker report as untrusted", () => {
	const p = plan();
	const prompt = buildAuditorPrompt({
		objective: p.objective,
		node: p.nodes[1]!,
		workerResult: "I implemented everything and all tests pass.",
		artifactsDir: ".pi/goals/orchestrator/runs/run-1",
		attempt: 1,
	});
	assert.match(prompt, /UNTRUSTED/);
	assert.match(prompt, /Inspect real artifacts/);
	assert.match(prompt, /<approved\/>/);
});

test("worker summary extraction is best effort", () => {
	assert.equal(extractWorkerSummary("SUMMARY: added export\nFILES: src/a.ts"), "added export (files: src/a.ts)");
	assert.equal(extractWorkerSummary("SUMMARY: only a summary"), "only a summary");
	assert.equal(extractWorkerSummary("first line\nsecond"), "first line");
});

test("run report is bounded and shows failures", () => {
	const p = plan();
	p.nodes[0]!.status = "done";
	p.nodes[0]!.summary = "contract written";
	p.nodes[0]!.lastAudit = { approved: true, disapproved: false, output: "<approved/>" };
	p.nodes[1]!.status = "failed";
	p.nodes[1]!.error = "Audit rejected: missing tests";
	p.nodes[1]!.lastAudit = { approved: false, disapproved: true, output: "missing tests" };
	const result: RunResult = {
		runId: "run-1",
		status: "failed",
		artifactDir: ".pi/goals/orchestrator/runs/run-1",
		objective: p.objective,
		nodes: p.nodes,
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:01:00.000Z",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, auditInput: 0, auditOutput: 0 },
		error: "backend failed",
	};
	const report = buildRunReport(result, 4000);
	assert.match(report, /FAILED/);
	assert.match(report, /\[failed\] backend/);
	assert.match(report, /missing tests/);
	assert.ok(report.length <= 4000);
	assert.equal(buildRunReport(result, 100).length, 100);
});
