# Validation

Data: 2026-10-22. Todos os testes abaixo usaram a extensão carregada via `pi -e` e o `@tintinweb/pi-subagents` real.

## 1. Unidade e typecheck

```bash
npm run check   # tsc --noEmit, 0 erros
npm test        # 35/35 testes
```

Cobertura:

- validação de plano, ciclos, deps desconhecidas, defaults e limites;
- ready set / bloqueio de dependentes;
- auditoria (marker final, reprovação, retry com feedback);
- prompt de worker sem transcript do pai e com branch de dependência;
- relatório compacto e truncado;
- RPC fake: ping, spawn, completion, consume, race do reply, timeout, erro;
- scheduler fake: fan-out paralelo, retry por auditoria, bloqueio, outputs ausentes, fail-fast;
- leitura do header de goal e da entrada `pi-goal-focus`.

## 2. DAG real com paralelismo

Projeto git temporário, 3 nós, auditoria desligada para isolar o scheduler:

```text
contract (docs/contract.md)
   ├── backend  (backend.txt)
   └── frontend (frontend.txt)
```

Resultado do `run.json`:

```text
contract done 13:33:50.174Z -> 13:34:04.336Z
backend  done 13:34:04.352Z -> 13:34:13.052Z
frontend done 13:34:04.352Z -> 13:34:14.724Z
```

Backend e frontend começaram no **mesmo timestamp**, depois do contrato. Os três arquivos foram criados. Custo: ~$0.0073.

## 3. Auditoria independente real

Projeto git temporário, 1 nó, auditoria ligada:

```text
write -> hello.txt com exatamente "hi"
```

Resultado: `done`, auditoria aprovada, custo ~$0.0029. Artefatos gerados em `.pi/goals/orchestrator/runs/<runId>/` (`brief`, `result`, `audit`, `node.json`, `run.json`).

## 4. Worktree isolation real

Projeto git temporário, 1 nó com `"isolation": "worktree"` e output declarado:

```text
wt -> wt.txt na branch pi-agent-a0093374-e8dd-4c3
```

- A árvore principal **não** recebeu `wt.txt`.
- O branch foi criado e continha o arquivo.
- O auditor leu a branch e aprovou.
- O `run.json` registrou `branch` e `audit.approved = true`.
- Custo: ~$0.0026.

Isso valida os dois pontos delicados: outputs de worktree são verificados na branch (`git cat-file`) e o auditor recebe instrução explícita para inspecionar a branch, não a árvore principal.
