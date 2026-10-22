# AGENTS.md — pi-goal-orchestrator

Extensão pi que orquestra um goal do pi-goal-x como DAG de subagentes auditados.

## Arquitetura

- `extensions/orchestrator.ts` — tool `run_goal_plan`, comandos, prompt hook.
- `src/dag.ts` — validação e primitivas puras do DAG. **Sem I/O.**
- `src/scheduler.ts` — executor: ready set, concorrência, retries, auditoria.
- `src/rpc.ts` — cliente da RPC do `@tintinweb/pi-subagents`.
- `src/audit.ts` — auditor isolado read-only por nó.
- `src/artifacts.ts` — persistência em `.pi/goals/orchestrator/runs/<id>/`.
- `src/prompt.ts` — prompts e relatório compacto.
- `src/goal.ts` — leitura best-effort do goal focado do pi-goal-x.
- `src/settings.ts` — configuração global/projeto.

## Invariantes

1. Nó só vira `done` após auditoria aprovada (quando `audit: true`).
2. Worker nunca recebe o transcript do pai; recebe brief + resumo dos deps.
3. Falha definitiva bloqueia dependentes; nunca “pula” silenciosamente.
4. Auditor é sessão isolada read-only e recebe a alegação do worker como untrusted.
5. `run_goal_plan` não roda dentro de subagente.
6. Escrita em artefatos é atômica; nada fora de `.pi/goals/orchestrator` (ou `artifactsRoot`).

## Testes

`npm test` cobre DAG, prompts, settings, leitura de goal e RPC com event bus falso. Não chame modelos reais nos testes.
