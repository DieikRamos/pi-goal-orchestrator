# pi-goal-orchestrator

Companion extension for [`pi-goal-x`](https://github.com/tmonk/pi-goal-x): it turns the focused goal into an **orchestrator session**. **All goal work runs in subagents**; the main session only plans, reviews and reports, so its context stays small. Each node only unblocks its dependents after an **independent audit**.

```
contract
   ├── backend   ─┐
   └── frontend  ─┴── integrate
```

## Requirements

- pi 1.3+
- `pi-goal-x` (optional, but it is the integration target)
- [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) — used over RPC (`subagents:rpc:spawn`)

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

## Usage

### Automatic (default)

Once a goal is **decided** in `pi-goal-x` (focused and `active`), the goal's
tasks are always executed by subagents:

1. **Delegation is enforced.** Until the goal objective has an orchestration
run, the main session may read, plan and dispatch, but `write`/`edit` calls are
blocked with a reason that points at `run_goal_plan`
(`"enforceSubagentWork": false` disables the guard).
2. Every turn of a goal that has no run yet gets a prompt guideline: the first
action must be `run_goal_plan`, using `{ "tasks": true }` when the goal already
has a task list.
3. If the turn ends without a plan, the final boundary (`agent_before_settle`)
continues the run **once** with a hidden planning message. Continuing at the
boundary (instead of queueing a new run) prevents a race with `pi-goal-x`'s own
continuation into a duplicate run.
4. The nudge is recorded in `.pi/goals/orchestrator/auto/<goalId>.json`; it is
not repeated for the same objective, and it never fires while another
continuation or queued message is waiting, or for a goal with
`autoContinue: false` (`/goal` opt-out). A tweaked objective is planned again; a
failed run is **not** retried automatically.

Disable the automatic parts with `"autoOrchestrate": false` (and the guard
with `"enforceSubagentWork": false`) in the settings file.

### Task mode: `tasks: true`

The simplest plan has no DAG at all. When the focused goal already has a task
list, `run_goal_plan` derives the plan from it:

- one **audited node per pending task**, in document order (a sequential chain);
- a final **integrated verification** node depending on the last task;
- a goal without pending tasks becomes a single objective node.

```json
{ "tasks": true }
```

`nodes` and `tasks: true` are mutually exclusive. For parallel branches or
worktree isolation, pass an explicit `nodes` DAG.

### Manual

Power users can force a planning turn at any time:

```text
/orchestrate
```

It bypasses the run/marker guards (still refuses while a run is in flight or
the goal is not active). `/orchestrate` works even when `autoOrchestrate` is
disabled.

Or ask the agent directly, with a more specific shape:

```text
Execute the goal using run_goal_plan. Create a contract node, then backend and
frontend in parallel, then an integrated verification node.
```

The agent calls:

```json
{
  "nodes": [
    {
      "id": "contract",
      "title": "Define the contract",
      "prompt": "Define the REST contract and shared types...",
      "outputs": ["docs/contract.md"]
    },
    {
      "id": "backend",
      "title": "Implement the backend",
      "deps": ["contract"],
      "prompt": "Implement the backend according to docs/contract.md...",
      "isolation": "worktree",
      "outputs": ["crates/api/src/entity.rs"]
    },
    {
      "id": "frontend",
      "title": "Implement the frontend",
      "deps": ["contract"],
      "prompt": "Implement the screen and client according to docs/contract.md...",
      "isolation": "worktree",
      "outputs": ["apps/web/src/entity.tsx"]
    },
    {
      "id": "verify",
      "title": "Integrated verification",
      "deps": ["backend", "frontend"],
      "prompt": "Run the build, tests, and the end-to-end flow. Fix whatever fails...",
      "audit": true
    }
  ],
  "max_concurrent": 3
}
```

Without `objective`/`goal_id`, the extension reads the focused goal from `.pi/goals/` and the session's `pi-goal-focus` entry.

## What happens

1. The plan is validated (ids, dependencies, cycles, limits) and persisted.
2. “Ready” nodes are spawned via `subagents:rpc:spawn`, up to `max_concurrent`.
3. Each worker receives only the node brief + summaries from its dependencies. No parent transcript.
4. When a worker finishes, the result is written and an independent auditor (isolated read-only session) inspects the real artifacts.
5. Approved → `done`, dependents unblocked. Rejected → the audit feedback goes into the prompt and the node is retried until `max_attempts`.
6. Definitive failure → dependents become `blocked`; the goal must not be marked complete.
7. A compact report returns to the orchestrator; the full transcript stays on disk.

The final `pi-goal-x` auditor remains the final authority. The DAG report is evidence, not a replacement.

## Artifacts

```text
.pi/goals/orchestrator/runs/<runId>/
  plan.json
  run.json
  report.md
  nodes/<id>/brief-attempt-1.md
  nodes/<id>/result-attempt-1.md
  nodes/<id>/audit-attempt-1.md
  nodes/<id>/node.json
  ../auto/<goalId>.json   # last automatic planning nudge
```

`/orchestrate-status` shows the latest run. `/orchestrate-settings` shows the resolved configuration. `/orchestrate` queues a planning turn for the focused goal now.

## Configuration

Optional, in `.pi/pi-goal-orchestrator.json` (project) or `~/.pi/agent/pi-goal-orchestrator.json` (global). Project values win.

```json
{
  "maxConcurrent": 3,
  "failFast": true,
  "autoOrchestrate": true,
  "enforceSubagentWork": true,
  "audit": {
    "enabled": true,
    "model": "opencode-go/deepseek-v4.1-flash"
  },
  "worker": {
    "model": "opencode-go/deepseek-v4.1-flash"
  },
  "defaultTimeoutSeconds": 1800,
  "defaultMaxAttempts": 2,
  "injectGoalGuidance": true,
  "artifactsRoot": ".pi/goals/orchestrator"
}
```

Tool parameters override the configuration.

## Parallelism and worktrees

- Parallel writers should use `"isolation": "worktree"`. `pi-subagents` commits the work to a `pi-agent-*` branch, and the branch name appears in the node result.
- The worktree is removed at the end; the branch remains in the repository. The orchestrator must merge and validate the branches before the integration node.
- If `worktreeIsolation` is disabled in the project, `pi-subagents` silently ignores the request. In that case, **do not run writers on the same files in parallel**: use `max_concurrent: 1` or disjoint file scopes.
- The project must be a git repository with at least one commit for worktrees to work.

## Safety and isolation

- The extension refuses to run inside subagents (`PI_SUBAGENT_CHILD=1`), preventing orchestration fan-out.
- The node auditor uses only `read`, `grep`, `find`, `ls`, `bash` and an empty resource loader; it does not inherit project skills or extensions.
- Workers do not inherit the parent history (`inheritContext: false`).
- `run_goal_plan` is blocking: the orchestrator turn waits until the DAG stabilizes. Press `Esc` to abort; running agents receive `stop`.
- The automatic trigger is bounded: at most one planning message per goal objective and one run per objective. It never retries a failed run on its own.
- `enforceSubagentWork` blocks `write`/`edit` in the main session while a focused active goal has no run for its current objective. It does not police `bash` redirection; a determined model can still bypass it.

## MVP limitations

- It does not automatically update `pi-goal-x` tasks; the orchestrator should call `update_goal_task` after the report.
- Task mode chains pending tasks sequentially; it does not infer parallelism between tasks.
- It does not automatically merge worktree branches; an integration/merge node must do that explicitly.
- It has no dashboard of its own; follow progress through the `pi-subagents` widget, `/agents`, and the artifacts.
- The report is textual; there is no structured per-node schema (the auditor reads the real files).

## Validation

What has been tested end to end (real parallel DAG, real audit, worktree + branch) is documented in [`docs/VALIDATION.md`](docs/VALIDATION.md).

## Development

```bash
npm install
npm run check
npm test
```

## License

MIT.
