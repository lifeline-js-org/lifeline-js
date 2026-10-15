// Verificação de estabilidade do lifeline.js.
//
// Importa o pacote pelo próprio nome ("lifeline.js" e "lifeline.js/core"),
// exatamente como um projeto consumidor faria, e exercita o contrato
// documentado no README: máquina de estados, grafo de dependências,
// rollback, concorrência, eventos do logger e prettyLogger.
//
//   npm run check                        # compila e roda
//   node scripts/stability-check.mjs     # a partir do dist já compilado
//
// Sai com código 1 se qualquer verificação falhar.

import assert from "node:assert/strict";

import { LifeLine, CleanupError, prettyLogger } from "lifeline.js";
import * as lifeline from "lifeline.js";
import * as core from "lifeline.js/core";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;

function section(title) {
  console.log(`\n${title}`);
}

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✔ ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✘ ${label}`);
    const detail = error instanceof Error && error.stack !== undefined ? error.stack : String(error);
    for (const line of detail.split("\n")) {
      console.log(`      ${line}`);
    }
  }
}

// Aguarda uma Promise sem deixar rejeição não tratada escapar, devolvendo
// o resultado como um envelope em vez de relançar.
function capture(promise) {
  return promise.then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
}

console.log("lifeline.js · verificação de estabilidade");
console.log(`node ${process.version}`);

// ---------------------------------------------------------------------------
section("1. Imports e API");

await check("entry principal e subpath core exportam a mesma API", () => {
  assert.equal(typeof LifeLine, "function");
  assert.equal(core.LifeLine, LifeLine);
  assert.equal(core.CleanupError, CleanupError);
  assert.equal(core.prettyLogger, prettyLogger);
  assert.deepEqual(Object.keys(lifeline).sort(), Object.keys(core).sort());
});

await check("CleanupError preserva nome do recurso e causa", () => {
  const cause = new Error("timeout ao desconectar");
  const error = new CleanupError("database", { cause });
  assert.ok(error instanceof Error);
  assert.equal(error.name, "CleanupError");
  assert.equal(error.resourceName, "database");
  assert.equal(error.cause, cause);
  assert.match(error.message, /database/);
});

// ---------------------------------------------------------------------------
section("2. Ciclo de vida básico");

await check("sobe em ordem topológica e desce na ordem inversa", async () => {
  const trace = [];
  const make = (name, dependsOn = []) => ({
    name,
    dependsOn,
    init() {
      trace.push(`init:${name}`);
    },
    close() {
      trace.push(`close:${name}`);
    },
  });

  const app = new LifeLine();
  app.register(make("config"));
  app.register(make("db", ["config"]));
  app.register(make("server", ["db"]));
  assert.equal(app.state, "created");

  const started = capture(app.start());
  assert.equal(app.state, "starting");
  assert.equal((await started).ok, true);
  assert.equal(app.state, "running");
  assert.deepEqual(trace, ["init:config", "init:db", "init:server"]);

  await app.shutdown();
  assert.equal(app.state, "stopped");
  assert.deepEqual(trace.slice(3), ["close:server", "close:db", "close:config"]);
});

await check("close() é opcional: recursos sem close são ignorados", async () => {
  const closed = [];
  const app = new LifeLine();
  app.register({ name: "with-close", async init() {}, async close() { closed.push("with-close"); } });
  app.register({ name: "without-close", async init() {} });

  assert.equal((await capture(app.start())).ok, true);
  await app.shutdown();
  assert.deepEqual(closed, ["with-close"]);
  assert.equal(app.state, "stopped");
});

await check("dependsOn é copiado no registro (mutação posterior não quebra o grafo)", async () => {
  const deps = ["config"];
  const app = new LifeLine();
  app.register({ name: "config", async init() {} });
  app.register({ name: "db", dependsOn: deps, async init() {} });
  deps.push("inexistente");

  const result = await capture(app.start());
  assert.equal(result.ok, true, String(result.error));
  assert.equal(app.state, "running");
  await app.shutdown();
});

await check("init() e close() executam no objeto original (this preservado)", async () => {
  const trace = [];
  const resource = {
    name: "db",
    label: "db",
    async init() {
      trace.push(`init:${this.label}`);
    },
    async close() {
      trace.push(`close:${this.label}`);
    },
  };

  const app = new LifeLine();
  app.register(resource);
  resource.label = "db-editado";

  assert.equal((await capture(app.start())).ok, true);
  await app.shutdown();
  assert.deepEqual(trace, ["init:db-editado", "close:db-editado"]);
});

// ---------------------------------------------------------------------------
section("3. Validação de nomes e do grafo (falha síncrona, estado created)");

await check("nome vazio ou com espaços nas bordas é rejeitado", () => {
  const app = new LifeLine();
  assert.throws(() => app.register({ name: "", init() {} }), /Nome de recurso inválido/);
  assert.throws(() => app.register({ name: " ", init() {} }), /Nome de recurso inválido/);
  assert.throws(() => app.register({ name: " db", init() {} }), /não pode começar nem terminar com espaço/);
  assert.throws(() => app.register({ name: "db ", init() {} }), /não pode começar nem terminar com espaço/);
  assert.equal(app.state, "created");
});

await check("recurso duplicado é rejeitado", () => {
  const app = new LifeLine();
  app.register({ name: "db", init() {} });
  assert.throws(() => app.register({ name: "db", init() {} }), /Recurso duplicado: "db"/);
  assert.equal(app.state, "created");
});

await check("dependência inexistente falha antes de qualquer init()", () => {
  let ran = false;
  const app = new LifeLine();
  app.register({
    name: "web",
    dependsOn: ["db"],
    init() {
      ran = true;
    },
  });

  assert.throws(() => app.start(), /Dependência inexistente: "web" depende de "db"/);
  assert.equal(app.state, "created");
  assert.equal(ran, false);
});

await check("dependência duplicada é rejeitada", () => {
  const app = new LifeLine();
  app.register({ name: "db", init() {} });
  app.register({ name: "web", dependsOn: ["db", "db"], init() {} });

  assert.throws(() => app.start(), /Dependência duplicada em "web": "db"/);
  assert.equal(app.state, "created");
});

await check("ciclo de dependência falha mostrando o caminho", () => {
  const app = new LifeLine();
  app.register({ name: "a", dependsOn: ["b"], init() {} });
  app.register({ name: "b", dependsOn: ["a"], init() {} });

  assert.throws(() => app.start(), /Ciclo de dependência detectado/);
  assert.throws(() => app.start(), /a → b → a/);
  assert.equal(app.state, "created");
});

// ---------------------------------------------------------------------------
section("4. Máquina de estados");

await check("register() lança fora do estado inicial", async () => {
  const app = new LifeLine();
  app.register({ name: "only", async init() {} });

  const started = capture(app.start());
  assert.throws(() => app.register({ name: "x", init() {} }), /fora do estado inicial/);
  assert.equal((await started).ok, true);
  assert.throws(() => app.register({ name: "x", init() {} }), /fora do estado inicial/);

  await app.shutdown();
  assert.throws(() => app.register({ name: "x", init() {} }), /fora do estado inicial/);
  assert.equal(app.state, "stopped");
});

await check("shutdown() durante a inicialização lança síncrono", async () => {
  const app = new LifeLine();
  app.register({
    name: "slow",
    async init() {
      await sleep(20);
    },
  });

  const started = capture(app.start());
  assert.throws(() => app.shutdown(), /enquanto a inicialização está em andamento/);
  assert.equal(app.state, "starting");
  assert.equal((await started).ok, true);
  assert.equal(app.state, "running");

  await app.shutdown();
  assert.equal(app.state, "stopped");
});

await check("start() após shutdown lança e o estado terminal se mantém", async () => {
  const app = new LifeLine();
  app.register({ name: "only", async init() {} });

  assert.equal((await capture(app.start())).ok, true);
  await app.shutdown();
  assert.equal(app.state, "stopped");
  assert.throws(() => app.start(), /o gerenciador já foi encerrado/);
  assert.equal(app.state, "stopped");
});

// ---------------------------------------------------------------------------
section("5. Contrato de erros no rollback");

// Cenário: a e b sobem, "boom" falha no init, "never" nunca é tentado.
function buildRollbackScenario() {
  const root = new Error("falha proposital no init");
  const closed = [];
  const app = new LifeLine();

  app.register({ name: "a", async init() {}, async close() { closed.push("a"); } });
  app.register({ name: "b", dependsOn: ["a"], async init() {}, async close() { closed.push("b"); } });
  app.register({
    name: "boom",
    dependsOn: ["b"],
    async init() {
      throw root;
    },
    async close() {
      closed.push("boom");
    },
  });
  app.register({ name: "never", async init() {}, async close() { closed.push("never"); } });

  return { app, root, closed };
}

await check("rollback limpo devolve o erro original e fecha na ordem inversa", async () => {
  const { app, root, closed } = buildRollbackScenario();

  const result = await capture(app.start());
  assert.equal(result.ok, false);
  assert.equal(result.error, root); // mesma referência, mesma pilha
  assert.deepEqual(closed, ["b", "a"]);
  assert.equal(app.state, "failed");
});

await check("quem falhou no init e quem nunca subiu não recebem close()", async () => {
  const { app, closed } = buildRollbackScenario();
  await capture(app.start());
  assert.equal(closed.includes("boom"), false);
  assert.equal(closed.includes("never"), false);
});

await check("shutdown() após falha é no-op (não re-tenta a limpeza)", async () => {
  const { app, closed } = buildRollbackScenario();
  await capture(app.start());

  assert.equal((await capture(app.shutdown())).ok, true);
  assert.equal(app.state, "failed");
  assert.deepEqual(closed, ["b", "a"]);
});

await check("start() após falha devolve a mesma rejeição", async () => {
  const { app, root } = buildRollbackScenario();

  const first = app.start();
  const handled = capture(first);
  assert.equal(app.start(), first);
  assert.equal((await handled).error, root);
  assert.equal(app.state, "failed");
});

await check("falha de limpeza vira AggregateError com causa e CleanupError", async () => {
  const root = new Error("init falhou");
  const closeCause = new Error("timeout ao desconectar");
  const app = new LifeLine();

  app.register({ name: "db", async init() {}, async close() {} });
  app.register({
    name: "cache",
    dependsOn: ["db"],
    async init() {},
    async close() {
      throw closeCause;
    },
  });
  app.register({
    name: "queue",
    dependsOn: ["cache"],
    async init() {
      throw root;
    },
  });

  const result = await capture(app.start());
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof AggregateError, "esperava AggregateError");
  assert.equal(result.error.cause, root);
  assert.equal(result.error.errors.length, 1);

  const [cleanupError] = result.error.errors;
  assert.ok(cleanupError instanceof CleanupError);
  assert.equal(cleanupError.resourceName, "cache");
  assert.equal(cleanupError.cause, closeCause);
  assert.equal(app.state, "failed");
});

// ---------------------------------------------------------------------------
section("6. Concorrência");

await check("start() concorrente compartilha a mesma Promise", async () => {
  const app = new LifeLine();
  app.register({
    name: "only",
    async init() {
      await sleep(10);
    },
  });

  const first = app.start();
  const second = app.start();
  assert.equal(second, first);
  assert.equal(app.state, "starting");
  assert.equal((await capture(first)).ok, true);
  assert.equal(app.state, "running");
});

await check("shutdown() concorrente e posterior compartilham a mesma Promise", async () => {
  const app = new LifeLine();
  app.register({
    name: "only",
    async init() {},
    async close() {
      await sleep(10);
    },
  });

  assert.equal((await capture(app.start())).ok, true);
  const first = app.shutdown();
  assert.equal(app.shutdown(), first);
  await first;
  assert.equal(app.state, "stopped");
  assert.equal(app.shutdown(), first);
});

// ---------------------------------------------------------------------------
section("7. Eventos do ciclo de vida (LifeLineLogger)");

await check("sequência correta de eventos na subida e na descida", async () => {
  const events = [];
  const make = (name, dependsOn = []) => ({ name, dependsOn, async init() {}, async close() {} });

  const app = new LifeLine({ logger: (event) => events.push(event) });
  app.register(make("config"));
  app.register(make("db", ["config"]));
  assert.equal((await capture(app.start())).ok, true);
  await app.shutdown();

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "resource:starting",
      "resource:ready",
      "resource:starting",
      "resource:ready",
      "start:resolved",
      "shutdown",
      "close:start",
      "close:end",
      "close:start",
      "close:end",
      "shutdown:resolved",
    ],
  );

  const starting = events.filter((event) => event.type === "resource:starting");
  assert.deepEqual(starting.map((event) => event.name), ["config", "db"]);
  assert.deepEqual(starting[1].dependsOn, ["config"]);

  const closing = events.filter((event) => event.type === "close:start");
  assert.deepEqual(closing.map((event) => event.name), ["db", "config"]);
  assert.deepEqual(closing.map((event) => event.reason), ["shutdown", "shutdown"]);

  for (const event of events) {
    if ("durationMs" in event) {
      assert.equal(typeof event.durationMs, "number");
      assert.ok(event.durationMs >= 0);
    }
  }
});

await check("falha emite skipped, aborted, rollback e start:rejected", async () => {
  const events = [];
  const root = new Error("broker indisponível");
  const make = (name, dependsOn = []) => ({ name, dependsOn, async init() {}, async close() {} });

  const app = new LifeLine({ logger: (event) => events.push(event) });
  app.register(make("config"));
  app.register({
    name: "queue",
    async init() {
      throw root;
    },
  });
  app.register(make("http", ["queue"]));
  app.register(make("metrics"));

  const result = await capture(app.start());
  assert.equal(result.ok, false);
  assert.equal(result.error, root);
  assert.equal(app.state, "failed");

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "resource:starting",
      "resource:ready",
      "resource:starting",
      "resource:failed",
      "resources:skipped",
      "resources:aborted",
      "rollback",
      "close:start",
      "close:end",
      "start:rejected",
    ],
  );

  const skipped = events.find((event) => event.type === "resources:skipped");
  assert.deepEqual(skipped.names, ["http"]);
  assert.equal(skipped.failedResource, "queue");

  const aborted = events.find((event) => event.type === "resources:aborted");
  assert.deepEqual(aborted.names, ["metrics"]);

  const failedEvent = events.find((event) => event.type === "resource:failed");
  assert.equal(failedEvent.error, root);

  const rejected = events.find((event) => event.type === "start:rejected");
  assert.equal(rejected.failedResource, "queue");
  assert.equal(rejected.closedCount, 1);
  assert.equal(rejected.leakedCount, 0);
});

// ---------------------------------------------------------------------------
section("8. prettyLogger");

await check("formata o ciclo completo com timestamps e sem cores forçadas", async () => {
  const lines = [];
  const logger = prettyLogger({ colors: false, write: (line) => lines.push(line) });
  const app = new LifeLine({ logger });
  const make = (name, dependsOn = []) => ({ name, dependsOn, async init() {}, async close() {} });

  app.register(make("config"));
  app.register(make("db", ["config"]));
  assert.equal((await capture(app.start())).ok, true);
  await app.shutdown();

  assert.ok(lines.length >= 12, `esperava ao menos 12 linhas, veio ${lines.length}`);
  for (const line of lines) {
    assert.match(line, /^\+\d+\.\d{2}s {4}\S/, `linha fora do formato: ${JSON.stringify(line)}`);
    assert.equal(line.includes("\u001b["), false, "cores indevidas com colors: false");
  }
  assert.ok(lines.some((line) => line.includes("app.start()")));
  assert.ok(lines.some((line) => line.includes("config no ar")));
  assert.ok(lines.some((line) => line.includes("db encerrando")));
  assert.ok(lines.some((line) => line.includes("app encerrado")));
});

await check("resumo de falha no log não altera a rejeição do start()", async () => {
  const lines = [];
  const root = new Error("broker indisponível");
  const logger = prettyLogger({ colors: false, write: (line) => lines.push(line) });
  const app = new LifeLine({ logger });

  app.register({ name: "config", async init() {}, async close() {} });
  app.register({
    name: "queue",
    dependsOn: ["config"],
    async init() {
      throw root;
    },
  });

  const result = await capture(app.start());
  assert.equal(result.ok, false);
  assert.equal(result.error, root);
  assert.equal(app.state, "failed");
  assert.ok(
    lines.some((line) => line.includes("LifelineStartError: queue falhou · 1 encerrados · 0 vazaram")),
    "resumo de falha ausente do log",
  );
});

// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} verificações · ${passed} ok · ${failed} falhas`);
if (failed > 0) {
  console.log("Resultado: há falhas — revise a saída acima antes de utilizar o pacote.");
  process.exitCode = 1;
} else {
  console.log("Resultado: estável — todas as verificações passaram.");
}
