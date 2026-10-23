# pi-goal-orchestrator

Plan work once, execute it as an **audited DAG of subagents**, and keep the main
session small. Plans are numbered and resumable; the extension is independent
of any goal extension.

```
/orchestrator-plan <draft>   →   numbered plan + plan.md artifact
/orchestrator-resume 3       →   DAG runs in subagents, nodes audited
```

```
contract
   ├── backend   ─┐
   └── frontend  ─┴── integrate
```

The dashboard sits next to `@tintinweb/pi-subagents`' agents widget: subagents
shows the live workers, this shows the plan they belong to.

## Requirements

- pi 1.3+
- [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) — used
  over RPC (`subagents:rpc:spawn`)

No `pi-goal-x` dependency.

## Install

```bash
# install directly from the repository:
pi install git:github.com/DieikRamos/pi-goal-orchestrator

# or from a local clone:
git clone https://github.com/DieikRamos/pi-goal-orchestrator
pi install ./pi-goal-orchestrator

# during development, without installing:
pi -e ./pi-goal-orchestrator
```

## Commands

| Command | What it does |
|---|---|
| `/orchestrator-plan <draft>` | Starts a planning turn: refine the objective, decompose it, and save a numbered plan. Nothing executes. |
| `/orchestrator-resume [number]` | Executes a stored plan. Without a number, picks the newest resumable plan (never a running one). |
| `/orchestrator-plan-list` | Lists plans: number, title, status and node count. |
| `/orchestrator-plan-clear [--yes]` | Deletes **all** stored plans (asks for confirmation; run artifacts under `runs/` are kept). |
| `/orchestrator-status [number]` | Details for one plan (or the latest plan/run). |
| `/orchestrator-settings` | Shows the resolved configuration. |

### `/orchestrator-plan`

```text
/orchestrator-plan Add CSV export to the reports screen; users pick a date range
```

The model sharpens the objective (asking at most a couple of questions when a
decision changes the plan), decomposes it into small nodes, and calls
`orchestrator_plan`. The tool allocates the plan number and writes:

```text
.pi/orchestrator/plans/<number>/
  plan.json   machine record (objective, requirements, nodes, status, run ref)
  plan.md     human-readable artifact
```

The reply tells you the number; run it with `/orchestrator-resume <number>`.

### `/orchestrator-resume`

```text
/orchestrator-resume        # newest planned/failed/aborted plan
/orchestrator-resume 3      # plan #3
```

This starts a turn whose only job is to call `orchestrator_run` with
`plan_number`. The tool prints a live progress result, and the dashboard shows
the plan with per-node status. Node work always runs in subagents; the main
session receives one compact report.

## Tools

### `orchestrator_plan`

Persists a plan. Parameters:

- `title` (required), `objective` (required)
- `requirements?: string[]`, `notes?`, `description?`
- `nodes?: PlanNodeSpec[]` — omit for a single objective node
- `max_concurrent?`, `fail_fast?`

Node fields: `id`, `prompt` (self-contained brief), `title?`, `deps?`,
`agent_type?`, `model?`, `thinking_level?`, `isolation?`, `max_turns?`,
`timeout_seconds?`, `audit?`, `max_attempts?`, `outputs?`.

### `orchestrator_run`

Executes a stored plan or an ad-hoc DAG. Parameters:

- `plan_number?: number` — execute a stored plan
- `nodes?: PlanNodeSpec[]` + `objective?: string` — ad-hoc DAG
- `max_concurrent?`, `fail_fast?`, `audit?`

The two modes are mutually exclusive. A run updates the plan status
(`running` → `complete` / `failed` / `aborted`) and records the run id.

## UI

A compact widget above the editor mirrors the subagents widget's style:

```
● Orchestrator
├─ #3 CSV export · running · 2/4 nodes
│   ⎿  ✓ contract · ✓ backend · ◐ frontend · ○ verify
└─ /orchestrator-plan-list · /orchestrator-status
```

Without an active run it lists the newest plans. The status bar shows
`#3 running 2/4` (or `3 plans` when idle). Disable it with `"widget": false`.

Live worker activity, tokens, and spinners stay in the subagents widget; click
through `/agents` to inspect a running node.

## What happens in a run

1. The stored plan is validated (ids, dependencies, cycles, limits) and persisted
   in the run directory.
2. “Ready” nodes are spawned via `subagents:rpc:spawn`, up to `max_concurrent`.
3. Each worker receives only the node brief + summaries from its dependencies.
   No parent transcript.
4. When a worker finishes, an independent auditor (isolated read-only session)
   inspects the real artifacts.
5. Approved → `done`, dependents unblocked. Rejected → audit feedback goes into
   the prompt and the node is retried until `max_attempts`.
6. Definitive failure → dependents become `blocked`; the plan is marked `failed`.

## Artifacts

```text
.pi/orchestrator/
  plans/<number>/plan.json
  plans/<number>/plan.md
  runs/<runId>/
    plan.json
    run.json
    report.md
    nodes/<id>/brief-attempt-1.md
    nodes/<id>/result-attempt-1.md
    nodes/<id>/audit-attempt-1.md
    nodes/<id>/node.json
```

## Configuration

Optional, in `.pi/pi-goal-orchestrator.json` (project) or
`~/.pi/agent/pi-goal-orchestrator.json` (global). Project values win.

```json
{
  "maxConcurrent": 3,
  "failFast": true,
  "widget": true,
  "audit": {
    "enabled": true,
    "model": "opencode-go/deepseek-v4.1-flash"
  },
  "worker": {
    "model": "opencode-go/deepseek-v4.1-flash"
  },
  "defaultTimeoutSeconds": 1800,
  "defaultMaxAttempts": 2,
  "artifactsRoot": ".pi/orchestrator"
}
```

Tool parameters override the configuration.

## Parallelism and worktrees

- Parallel writers should use `"isolation": "worktree"`. `pi-subagents`
  commits the work to a `pi-agent-*` branch, and the branch name appears in the
  node result.
- The worktree is removed at the end; the branch remains in the repository. An
  integration/merge node must merge and validate the branches.
- If `worktreeIsolation` is disabled in the project, `pi-subagents` silently
  ignores the request. In that case **do not run writers on the same files in
  parallel**: use `max_concurrent: 1` or disjoint file scopes.
- The project must be a git repository with at least one commit for worktrees.

## Safety and isolation

- The extension refuses to run inside subagents (`PI_SUBAGENT_CHILD=1`),
  preventing orchestration fan-out.
- The node auditor uses only `read`, `grep`, `find`, `ls`, `bash` and an empty
  resource loader; it does not inherit project skills or extensions.
- Workers do not inherit the parent history (`inheritContext: false`).
- `orchestrator_run` is blocking: the turn waits until the DAG stabilizes. Press
  `Esc` to abort; running agents receive `stop`.
- Plan and run writes are atomic and stay under `artifactsRoot`.

## Limitations

- A plan is a DAG of nodes, not a scheduler: tasks run in dependency order, and
  the plan does not infer parallelism.
- It does not merge worktree branches automatically.
- The report is textual; the auditor reads the real files.
- Plan numbers are allocated per project (`artifactsRoot`); concurrent pi
  processes creating plans at the same instant are not coordinated.

## Validation

Unit tests, the fake-API wiring tests, and the real end-to-end DAG/audit/worktree
runs are documented in [`docs/VALIDATION.md`](docs/VALIDATION.md).

## Development

```bash
npm install
npm run check
npm test
```

## License

MIT.
