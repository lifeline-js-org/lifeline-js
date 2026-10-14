# Exemplos

Exemplos executáveis do Lifeline, do mais simples ao mais completo. Todos usam `import { LifeLine } from "lifeline.js"`, como num projeto que instalou o pacote.

| Arquivo | O que demonstra |
|---|---|
| `basic.js` | Registrar recursos, iniciar, encerrar |
| `dependencies.js` | `dependsOn`, ordem topológica e encerramento inverso |
| `error-handling.js` | Rollback em falha de `init()`, `AggregateError` e `CleanupError` |
| `graceful-shutdown.js` | Servidor HTTP real + SIGINT/SIGTERM com encerramento gracioso |

## Como executar

Num projeto que já tem o pacote instalado:

```sh
npm install lifeline.js
node examples/basic.js
```

A partir deste repositório, empacote e instale localmente:

```sh
npm run build
npm pack            # gera lifeline.js-0.1.0.tgz
mkdir /tmp/meu-app && cd /tmp/meu-app
npm init -y && npm pkg set type=module
npm install /caminho/para/lifeline.js-0.1.0.tgz
node /caminho/desta/pasta/examples/basic.js
```

O `graceful-shutdown.js` sobe um servidor de verdade — rode, faça um `curl http://localhost:3000/` e pressione `Ctrl+C` para ver o encerramento em ordem inversa.
