# Validation

Date: 2026-10-22. Every test below loaded the extension via `pi -e` and used the real `@tintinweb/pi-subagents`.

## 1. Unit tests and typecheck

```bash
npm run check   # tsc --noEmit, 0 errors
npm test        # 55/55 tests
```

Coverage:

- plan validation, cycles, unknown deps, defaults, and limits;
- ready set / dependent blocking;
- auditing (final marker, rejection, retry with feedback);
- worker prompt without the parent transcript and with dependency branch info;
- compact and truncated report;
- fake RPC: ping, spawn, completion, consume, reply race, timeout, error;
- fake scheduler: parallel fan-out, audit rejection retry, blocking, missing outputs, fail-fast;
- goal header and `pi-goal-focus` entry parsing;
- task-mode planning: one audited node per pending task chained in order, integrated
  verification node, single objective node without tasks, derived ids pass plan validation;
- automatic trigger decisions: disabled/unfocused/paused/empty/in-flight/auto-continue opt-out,
  force bypass, one nudge per objective signature, re-plan after a tweak, no auto-retry
  of a failed run, marker roundtrip and malformed run files;
- extension wiring with a fake API: tool/command/hook registration, exactly one boundary
  continuation for a decided goal, opt-out respected, the write/edit guard opening
  after a completed run, and `/orchestrate-mode` toggling project settings;
- settings mutations: atomic project-settings write preserving unknown keys, no temp file left behind.

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
