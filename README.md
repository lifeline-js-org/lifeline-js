# lifeline.js

Gerenciamento de ciclo de vida para aplicações Node.js: inicialização sequencial de recursos, rollback em caso de falha e encerramento ordenado — com dependências entre recursos e um contrato de erros explícito.

## Instalação

```sh
npm install lifeline.js
```

**Requisitos:** Node.js 24 ou superior. O pacote é ESM-only (`"type": "module"`).

## Começando

```js
import { LifeLine } from "lifeline.js";

const app = new LifeLine();

app.register({
  name: "database",
  async init() {
    await db.connect(process.env.DATABASE_URL);
    console.log("Database connected");
  },
  async close() {
    await db.disconnect();
    console.log("Database disconnected");
  },
});

app.register({
  name: "server",
  dependsOn: ["database"],
  async init() {
    server.listen(3000);
    console.log("Server started");
  },
  async close() {
    await new Promise((resolve) => server.close(resolve));
    console.log("Server stopped");
  },
});

await app.start();

process.on("SIGTERM", () => {
  void app.shutdown().then(
    () => process.exit(0),
    (error) => {
      console.error("Falha ao encerrar:", error);
      process.exit(1);
    },
  );
});
```

Um recurso é um objeto com `name`, `init()` e, opcionalmente, `close()` e `dependsOn`. Os exemplos acima usam objetos imaginários (`db`, `server`); numa aplicação real, `init()` e `close()` chamam as APIs correspondentes.

## Imports modulares

Além do entry principal, o núcleo está disponível como subpath — a mesma API, consumível como `lifeline.js/core`:

```js
import { LifeLine } from "lifeline.js/core";
```

Módulos como `lifeline.js/http` e `lifeline.js/signals` estão no roadmap e ganharão subpaths próprios quando tiverem funcionalidade concreta.

## Logs

O gerenciador emite eventos estruturados do ciclo de vida quando você passa um `logger` na construtora. O `prettyLogger()` embutido imprime tudo no console com timestamp relativo, cores e durações:

```js
import { LifeLine, prettyLogger } from "lifeline.js";

const app = new LifeLine({ logger: prettyLogger() });
```

```text
+0.00s    app.start()
+0.00s    config iniciando
+0.35s    config no ar · 0.35s
+0.35s    postgres iniciando (precisa de config)
+1.45s    postgres no ar · 1.10s
+1.45s    redis iniciando (precisa de config)
+2.05s    redis falhou: ETIMEDOUT redis:6379
+2.05s    queue, http ignorados: dependem de redis
+2.05s    rollback: encerrando 2 em ordem inversa
+2.05s    postgres encerrando
+2.70s    postgres encerrado · 0.65s
+2.70s    config encerrando
+2.85s    config encerrado · 0.15s
+2.85s    LifelineStartError: redis falhou · 2 encerrados · 0 vazaram
```

Detalhes que valem saber:

- Sem `logger`, nada é logado: o gerenciador não escreve em `console` por conta própria.
- Cores ligam automaticamente quando há TTY e desligam com `NO_COLOR`; `prettyLogger({ colors })` força o estado e `prettyLogger({ write })` redireciona a saída (arquivo, pipeline, etc.).
- A linha `LifelineStartError: ...` é **só um resumo do log** — o `start()` segue rejeitando com o erro original (ou `AggregateError` com falhas de limpeza), como descrito em [Tratamento de erros](#tratamento-de-erros).
- Para outro destino (serviço de métricas, log estruturado), implemente `LifeLineLogger`: um consumidor único de eventos (`start`, `resource:starting`, `resource:ready`, `resource:failed`, `resources:skipped`, `resources:aborted`, `rollback`, `close:start`, `close:end`, `start:resolved`, `start:rejected`, `shutdown`, `shutdown:resolved`, `shutdown:rejected`). O logger é chamado de forma síncrona dentro do ciclo de vida: mantenha-o rápido e não lance erros nele.
- Exemplo executável: [`examples/logging.js`](examples/logging.js).

## Encerramento e sinais

`shutdown()` fecha os recursos **na ordem inversa da inicialização efetiva**, aguardando cada `close()`. Recursos sem `close()` são ignorados. Falhas em `close()` não interrompem a limpeza: todos os recursos restantes são tentados, e a rejeição é um `AggregateError` com um `CleanupError` por recurso (nome + erro real em `cause`).

Chamadas concorrentes a `shutdown()` compartilham a mesma operação, e chamadas posteriores reutilizam a mesma Promise — sem fechar nada duas vezes.

### `shutdown()` durante a inicialização lança um erro síncrono

Este é um detalhe importante do contrato: se `start()` ainda está em andamento (estado `starting`), `shutdown()` **lança imediatamente** — ele não agenda o encerramento para depois. Se um `init()` chamar `shutdown()` sem tratar o erro, o próprio `init()` falha e dispara o rollback.

```js
const starting = app.start();

try {
  app.shutdown(); // lança: "Não é possível chamar shutdown() enquanto a inicialização está em andamento"
} catch (error) {
  // decida: aguardar start() (sucesso ou falha) e então chamar shutdown()
}
```

Aguardar `await app.start()` antes de chamar `shutdown()` é o padrão correto — inclusive no handler de `SIGTERM` do exemplo acima, se o sinal puder chegar durante a subida.

## Tratamento de erros

Se um `init()` falha, os recursos já inicializados são fechados em ordem inversa (rollback) e o `start()` rejeita:

- **Rollback limpo:** o erro original chega **como está** — mesmo objeto, mesma pilha, mesmo valor se não for `Error`.
- **Rollback com falhas de limpeza:** a rejeição é um `AggregateError` com o erro original em `cause` e um `CleanupError` por recurso em `errors`.

```js
try {
  await app.start();
} catch (error) {
  if (error instanceof AggregateError) {
    console.error("Causa raiz:", error.cause);
    for (const cleanupError of error.errors) {
      console.error(`Falha ao fechar ${cleanupError.resourceName}:`, cleanupError.cause);
    }
  } else {
    console.error("Falha na inicialização:", error);
  }
}
```

**Políticas que valem conhecer:**

- O rollback é executado **uma única vez**. Após uma falha, o estado fica `failed` (terminal) e `shutdown()` é um no-op — não é mecanismo de recuperação. Os erros permanecem acessíveis na Promise rejeitada do `start()`.
- Um recurso cujo `init()` falha **não** recebe `close()`: cada `init()` é responsável por limpar seus próprios efeitos parciais quando rejeitar.
- Recursos que não conseguiram fechar durante um `shutdown()` com falha **não são re-tentados automaticamente** — trate-os manualmente a partir do `AggregateError`.

## Máquina de estados

```
created ──start()──▶ starting ──▶ running ──shutdown()──▶ stopping ──▶ stopped
   │                    │
   │                    └──▶ failed (rollback concluído; terminal)
   └──shutdown()──────────────────────────────▶ stopping ──▶ stopped
```

O estado é exposto pelo getter `state`.

| Operação | `created` | `starting` | `running` | `stopping` | `stopped` | `failed` |
|---|---|---|---|---|---|---|
| `register()` | ✅ | ❌ lança | ❌ lança | ❌ lança | ❌ lança | ❌ lança |
| `start()` | inicia | mesma Promise | mesma Promise | ❌ lança | ❌ lança | mesma rejeição |
| `shutdown()` | encerra vazio | ❌ lança | encerra | mesma Promise | mesma Promise | no-op |

As violações de estado **lançam sincronamente**; falhas operacionais rejeitam a Promise.

## Dependências entre recursos

- `dependsOn?: readonly string[]` é opcional; sem dependências, a ordem efetiva é a de registro.
- A ordem de inicialização é topológica: toda dependência é inicializada antes de quem depende dela. O encerramento inverte a ordem efetiva.
- Antes de qualquer `init()`, `start()` valida e falha síncronamente (o gerenciador permanece em `created`): dependência inexistente, dependência duplicada e ciclo de dependência — o erro do ciclo mostra o caminho (`a → b → a`).
- Nomes devem ser não vazios e sem espaços nas bordas; `name` e `dependsOn` são copiados no registro (mutações posteriores no objeto não afetam a configuração), enquanto `init()` e `close()` executam no objeto original.

## Concorrência

`start()` e `shutdown()` armazenam suas Promises: chamadas concorrentes — inclusive reentrantes, de dentro de um `init()` — recebem a **mesma Promise**, e a operação roda uma única vez. Cada chamada deve ser tratada pelo consumidor: compartilhar a Promise significa que uma rejeição não tratada em qualquer chamada vira unhandled rejection.

## Limitações v1

- Sem retry automático de inicialização (`failed` é terminal).
- Sem inicialização paralela: tudo é sequencial e aguardado.
- `dependsOn` é lista estrita de dependências obrigatórias (sem opcionais/condicionais).
- Ordem de dependências via DFS recursivo: cadeias extremamente longas podem estourar a pilha.

## Exemplos

A pasta [`examples/`](examples/) traz exemplos executáveis, do mais simples ao completo: registro básico, dependências entre recursos, tratamento de erros com rollback, logs do ciclo de vida com `prettyLogger` e encerramento gracioso de um servidor HTTP real com SIGINT/SIGTERM.

## Testes

```sh
npm test
```

Compila com `tsc` e roda a suíte com o `node --test` contra o `dist` real. Os testes são organizados por comportamento:

| Arquivo | Comportamento |
|---|---|
| `registration.test.mjs` | Registro e validação de nomes/estados |
| `dependencies.test.mjs` | Ordem de dependências e validação do grafo |
| `initialization.test.mjs` | Inicialização e concorrência |
| `rollback.test.mjs` | Rollback e preservação de erros |
| `shutdown.test.mjs` | Encerramento e estados terminais |
| `logger.test.mjs` | Eventos do ciclo de vida e `prettyLogger` |
| `package.test.mjs` | Entry principal e subpaths |

A implementação está com 100% de linhas, branches e funções cobertos.

## Licença

MIT
