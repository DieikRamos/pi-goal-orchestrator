# pi-goal-orchestrator

Extensão companheira do [`pi-goal-x`](https://github.com/tmonk/pi-goal-x): transforma o goal focado em uma **sessão orquestradora**. O agente principal planeja e revisa; workers rodam em contextos separados; cada nó só libera dependentes depois de uma **auditoria independente**.

```
contract
   ├── backend   ─┐
   └── frontend  ─┴── integrate
```

## Requisitos

- pi 1.3+
- `pi-goal-x` (opcional, mas é o alvo da integração)
- [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) — usado via RPC (`subagents:rpc:spawn`)

## Instalar

```bash
pi install /home/dieikramos/code-projects/pi-goal-orchestrator
# ou, durante o desenvolvimento:
pi -e /home/dieikramos/code-projects/pi-goal-orchestrator
```

## Uso

Com um goal focado no `pi-goal-x`, peça ao agente para executar o plano:

```text
Execute o goal usando run_goal_plan. Crie um nó de contrato, depois backend e
frontend em paralelo, depois um nó de verificação integrada.
```

O agente chama:

```json
{
  "nodes": [
    {
      "id": "contract",
      "title": "Definir contrato",
      "prompt": "Defina o contrato REST e os tipos compartilhados...",
      "outputs": ["docs/contract.md"]
    },
    {
      "id": "backend",
      "title": "Implementar backend",
      "deps": ["contract"],
      "prompt": "Implemente o backend conforme docs/contract.md...",
      "isolation": "worktree",
      "outputs": ["crates/api/src/entity.rs"]
    },
    {
      "id": "frontend",
      "title": "Implementar frontend",
      "deps": ["contract"],
      "prompt": "Implemente a tela e o client conforme docs/contract.md...",
      "isolation": "worktree",
      "outputs": ["apps/web/src/entity.tsx"]
    },
    {
      "id": "verify",
      "title": "Verificação integrada",
      "deps": ["backend", "frontend"],
      "prompt": "Rode build, testes e o fluxo ponta a ponta. Corrija o que falhar...",
      "audit": true
    }
  ],
  "max_concurrent": 3
}
```

Sem `objective`/`goal_id`, a extensão lê o goal focado em `.pi/goals/` e a entrada `pi-goal-focus` da sessão.

## O que acontece

1. O plano é validado (ids, dependências, ciclos, limites) e persistido.
2. Nós “ready” são disparados via `subagents:rpc:spawn`, até `max_concurrent`.
3. Cada worker recebe só o brief do nó + resumo dos dependentes. Sem transcript do pai.
4. Ao terminar, o resultado é gravado e um auditor independente (sessão isolada read-only) inspeciona os artefatos reais.
5. Aprovado → `done` e dependentes liberados. Reprovado → o feedback volta no prompt e o nó é repetido até `max_attempts`.
6. Falha definitiva → dependentes ficam `blocked`; o goal não deve ser marcado completo.
7. O relatório volta compacto para o orquestrador; o transcript completo fica em disco.

O auditor final do `pi-goal-x` continua sendo a autoridade final. O relatório do DAG é evidência, não substituto.

## Artefatos

```text
.pi/goals/orchestrator/runs/<runId>/
  plan.json
  run.json
  report.md
  nodes/<id>/brief-attempt-1.md
  nodes/<id>/result-attempt-1.md
  nodes/<id>/audit-attempt-1.md
  nodes/<id>/node.json
```

`/orchestrate-status` mostra o último run. `/orchestrate-settings` mostra a configuração resolvida.

## Configuração

Opcional, em `.pi/pi-goal-orchestrator.json` (projeto) ou `~/.pi/agent/pi-goal-orchestrator.json` (global). O projeto vence.

```json
{
  "maxConcurrent": 3,
  "failFast": true,
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

Parâmetros da tool vencem a configuração.

## Paralelismo e worktrees

- Writers paralelos devem usar `"isolation": "worktree"`. O `pi-subagents` commita o trabalho em um branch `pi-agent-*` e o nome aparece no resultado/branch do nó.
- O worktree é removido ao final; o branch fica no repositório. O orquestrador precisa mergear/validar os branches antes do nó de integração.
- Se `worktreeIsolation` estiver desligado no projeto, o `pi-subagents` ignora o pedido. Nesse caso, **não rode writers nos mesmos arquivos em paralelo**: use `max_concurrent: 1` ou escopos de arquivo disjuntos.
- Projeto precisa ser git com pelo menos um commit para worktree funcionar.

## Segurança e isolamento

- A extensão se recusa a rodar dentro de subagentes (`PI_SUBAGENT_CHILD=1`), evitando explosão de orquestração.
- O auditor de nó usa apenas `read`, `grep`, `find`, `ls`, `bash` e um resource loader vazio; não herda skills/extensões do projeto.
- Workers não herdam o histórico do pai (`inheritContext: false`).
- O `run_goal_plan` é bloqueante: o turno do orquestrador espera o DAG estabilizar. Use `Esc` para abortar; os agentes em execução recebem `stop`.

## Limitações do MVP

- Não atualiza automaticamente as tarefas do `pi-goal-x`; o orquestrador deve chamar `update_goal_task` depois do relatório.
- Não faz merge automático de branches de worktree; um nó de integração/merge deve fazer isso explicitamente.
- Não tem dashboard próprio; acompanhe via widget do `pi-subagents`, `/agents` e artefatos.
- O relatório é textual; não há schema estruturado por nó (o auditor lê arquivos reais).

## Desenvolvimento

```bash
npm install
npm run check
npm test
```

## Licença

MIT.
