# AGENTS.md — pi-goal-orchestrator

Pi extension that turns numbered plans into an audited DAG of `pi-subagents`.
Independent of `pi-goal-x`.

## Architecture

- `extensions/orchestrator.ts` — tools (`orchestrator_plan`, `orchestrator_run`),
  commands, session lifecycle.
- `src/plans.ts` — numbered plan store (`plans/<n>/plan.json` + `plan.md`), pure
  resume/list helpers.
- `src/dag.ts` — plan validation and pure DAG primitives. **No I/O.**
- `src/scheduler.ts` — executor: ready set, concurrency, retries, auditing.
- `src/rpc.ts` — `@tintinweb/pi-subagents` RPC client.
- `src/audit.ts` — isolated read-only per-node auditor.
- `src/artifacts.ts` — run persistence under `<artifactsRoot>/runs/<id>/`.
- `src/fsutil.ts` — atomic writes and path helpers.
- `src/prompt.ts` — worker/auditor/planning/resume prompts and compact report.
- `src/ui.ts` — above-editor dashboard widget, styled like the agents widget.
- `src/settings.ts` — global/project configuration.

## Flow

1. `/orchestrator-plan <draft>` starts a hidden planning turn; the model calls
   `orchestrator_plan`, which allocates the next number and persists the plan.
2. `/orchestrator-resume [n]` starts an execution turn; the model calls
   `orchestrator_run` with `plan_number`.
3. `orchestrator_run` executes the stored DAG and updates the plan status.

## Invariants

1. A node only becomes `done` after an approved audit (when `audit: true`).
2. A worker never receives the parent transcript; it gets the brief + dependency summaries.
3. Definitive failure blocks dependents; nothing is silently skipped.
4. The auditor is an isolated read-only session and treats the worker's claim as untrusted.
5. `orchestrator_run` never runs inside a subagent.
6. Artifact and plan writes are atomic; nothing is written outside `artifactsRoot`.
7. Plan numbers are stable and monotonic per project; a plan is never renumbered.
8. Planning and execution are separate turns: `/orchestrator-plan` never executes.

## Tests

`npm test` covers plan storage/numbering/resume, DAG logic, prompts, settings,
RPC, scheduler, UI view helpers, and the extension wiring with a fake API.
Never call real models in tests.
