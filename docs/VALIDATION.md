# Validation

Date: 2026-10-22. Every test below loaded the extension via `pi -e` and used the real `@tintinweb/pi-subagents`.

## 1. Unit tests and typecheck

```bash
npm run check   # tsc --noEmit, 0 errors
npm test        # 48/48 tests
```

Coverage:

- plan validation, cycles, unknown deps, defaults, and limits;
- ready set / dependent blocking;
- auditing (final marker, rejection, retry with feedback);
- worker prompt without the parent transcript and with dependency branch info;
- compact and truncated report;
- fake RPC: ping, spawn, completion, consume, reply race, timeout, error;
- fake scheduler: parallel fan-out, audit rejection retry, blocking, missing outputs, fail-fast;
- plan store: numbering from the highest existing plan, atomic plan.json/plan.md writes,
  list/get/update, malformed plan directories ignored, resume target resolution
  (explicit number, newest resumable, running plans excluded by default), and
  clearAll deleting plans while leaving run artifacts intact;
- plan artifacts: markdown rendering with objective, requirements, notes, node deps,
  and the last run node outcomes (status/attempts) persisted back into plan.json;
- extension wiring with a fake API: tool/command/session-hook registration,
  `/orchestrator-plan` sending the hidden planning turn, `/orchestrator-resume`
  resolving and refusing running plans, plan-list/status output, and the dashboard
  widget/status line, `orchestrator_run` rejecting an unknown plan before
  touching subagents, and `/orchestrator-plan-clear` guarding confirmation
  (headless refusal without `--yes`) and clearing all plans;
- settings mutations: atomic project-settings write preserving unknown keys, no temp file left behind.

The goal-specific tests from the previous version (goal header parsing, task-mode
planning, automatic goal trigger, write/edit guard) were removed together with the
`pi-goal-x` dependency.

## 2. Real DAG with parallelism

Temporary git project, 3 nodes, auditing disabled to isolate the scheduler:

```text
contract (docs/contract.md)
   ├── backend  (backend.txt)
   └── frontend (frontend.txt)
```

`run.json` result:

```text
contract done 13:33:50.174Z -> 13:34:04.336Z
backend  done 13:34:04.352Z -> 13:34:13.052Z
frontend done 13:34:04.352Z -> 13:34:14.724Z
```

Backend and frontend started at the **same timestamp**, after the contract. All three files were created. Cost: ~$0.0073.

## 3. Real independent audit

Temporary git project, 1 node, auditing enabled:

```text
write -> hello.txt containing exactly "hi"
```

Result: `done`, audit approved, cost ~$0.0029. Artifacts generated under `.pi/goals/orchestrator/runs/<runId>/` (`brief`, `result`, `audit`, `node.json`, `run.json`).

## 4. Real worktree isolation

Temporary git project, 1 node with `"isolation": "worktree"` and a declared output:

```text
wt -> wt.txt on branch pi-agent-a0093374-e8dd-4c3
```

- The main tree did **not** receive `wt.txt`.
- The branch was created and contained the file.
- The auditor read the branch and approved.
- `run.json` recorded `branch` and `audit.approved = true`.
- Cost: ~$0.0026.

This validates the two delicate points: worktree outputs are checked on the branch (`git cat-file`), and the auditor is explicitly told to inspect the branch, not the main working tree.

## 5. Real numbered plan flow (2026-10-22)

Temporary git project, **no goal extension**, real model and real `pi-subagents`:

```text
pi -e <repo> -p "Call orchestrator_plan ..."      → plan #1
pi -e <repo> -p "Call orchestrator_run plan 1"    → run complete
```

- `orchestrator_plan` wrote `.pi/orchestrator/plans/1/plan.json` and `plan.md`.
- `orchestrator_run` spawned node `write`, the independent auditor approved it,
  and `hello.txt` contained `Hi`.
- `plan.json` recorded `status: complete` and the run id.
- Artifacts: `.pi/orchestrator/runs/<runId>/` (`plan.json`, `run.json`, `report.md`,
  per-node brief/result/audit).

A real `pi -e … -p` load also confirmed the tools are registered as
`orchestrator_plan` and `orchestrator_run`.


## 6. Real command test over RPC (2026-10-22)

`pi --mode rpc --no-session` in a temp project with two plan directories and a
run artifact, then:

```json
{"type":"prompt","message":"/orchestrator-plan-clear --yes"}
```

Result: response `handled`, the `plans/` directory was removed, the
`runs/run-1/run.json` artifact was kept, and the `Cleared 2 plans.` notification
was emitted. The same session also emitted `setWidget`/`setStatus` calls,
confirming the dashboard hooks run in a real pi process.
