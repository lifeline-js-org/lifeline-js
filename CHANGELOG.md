# Changelog

## Não lançado

### Logs

- `logger` opcional na construtora do `LifeLine` (`new LifeLine({ logger })`):
  eventos estruturados de todo o ciclo de vida (`start`, `resource:starting`,
  `resource:ready`, `resource:failed`, `resources:skipped`, `resources:aborted`,
  `rollback`, `close:start`, `close:end`, `start:resolved`, `start:rejected`,
  `shutdown`, `shutdown:resolved`, `shutdown:rejected`). Sem `logger`, nada é
  logado — comportamento e contrato de erros inalterados.
- `prettyLogger()`: formatador de console pronto para uso, com timestamps
  relativos (`+1.45s`), cores (TTY/`NO_COLOR`) e saída redirecionável.
- `examples/logging.js`: cenário de falha do redis com rollback completo.

## 0.1.0

Primeira versão pública.

### Núcleo

- `LifeLine`: gerenciador de ciclo de vida com máquina de estados explícita
  (`created`, `starting`, `running`, `stopping`, `stopped`, `failed`).
- `register()`: recursos com `name`, `init()`, `close()` opcional e
  `dependsOn` opcional; nomes e dependências são copiados no registro.
- `start()`: inicialização sequencial em ordem topológica, validação de
  dependências (inexistentes, duplicadas, ciclos) antes de qualquer `init()`,
  e coordenação de chamadas concorrentes/reentrantes pela mesma Promise.
- Rollback: em falha de `init()`, os recursos inicializados são fechados em
  ordem inversa, continuando mesmo com falhas de `close()`.
- `shutdown()`: encerramento em ordem inversa da inicialização efetiva, com
  a mesma garantia de coordenação de chamadas.
- Erros: preservação do valor original (inclusive não-`Error`), `AggregateError`
  com `cause` para falhas de limpeza e `CleanupError` identificando cada
  recurso que falhou ao fechar.

### Pacote

- ESM-only, Node.js >= 24, entry principal e subpath `lifeline.js/core`.
