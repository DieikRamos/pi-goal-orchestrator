# AGENTS.md — pi-goal-orchestrator

Pi extension that orchestrates a `pi-goal-x` goal as a DAG of audited subagents.

## Architecture

- `extensions/orchestrator.ts` — `run_goal_plan` tool, commands, prompt hook.
- `src/dag.ts` — plan validation and pure DAG primitives. **No I/O.**
- `src/scheduler.ts` — executor: ready set, concurrency, retries, auditing.
- `src/rpc.ts` — `@tintinweb/pi-subagents` RPC client.
- `src/audit.ts` — isolated read-only per-node auditor.
- `src/artifacts.ts` — persistence under `.pi/goals/orchestrator/runs/<id>/`.
- `src/prompt.ts` — prompts and compact report.
- `src/goal.ts` — best-effort reader for the focused `pi-goal-x` goal.
- `src/settings.ts` — global/project configuration.

## Invariants

1. A node only becomes `done` after an approved audit (when `audit: true`).
2. A worker never receives the parent transcript; it gets the brief + dependency summaries.
3. Definitive failure blocks dependents; nothing is silently skipped.
4. The auditor is an isolated read-only session and treats the worker's claim as untrusted.
5. `run_goal_plan` never runs inside a subagent.
6. Artifact writes are atomic; nothing is written outside `.pi/goals/orchestrator` (or `artifactsRoot`).

## Tests

`npm test` covers DAG logic, prompts, settings, goal reading, and RPC with a fake event bus. Never call real models in tests.
