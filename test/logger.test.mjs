import test from "node:test";
import assert from "node:assert/strict";

import { LifeLine, prettyLogger } from "../dist/index.js";

import { captureRejection } from "./_helpers.mjs";

// Reduz os valores de duração para um placeholder estável: os tempos reais
// variam a cada execução e o que interessa aqui é o formato da linha.
const normalize = (line) =>
  line.replace(/^\+\d+\.\d\ds +/, "").replace(/· \d+\.\d\ds/g, "· Xs");

function createLine(events) {
  return new LifeLine({ logger: (event) => events.push(event) });
}

function createApp(events) {
  const line = createLine(events);
  const tracked = (name, dependsOn) => ({
    name,
    ...(dependsOn === undefined ? {} : { dependsOn }),
    init: async () => {},
    close: async () => {},
  });
  return { line, tracked };
}

test("um ciclo de sucesso emite start, transições por recurso e start:resolved", async () => {
  const events = [];
  const { line, tracked } = createApp(events);

  line.register(tracked("database"));
  line.register(tracked("server", ["database"]));

  await line.start();

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "resource:starting",
      "resource:ready",
      "resource:starting",
      "resource:ready",
      "start:resolved",
    ],
  );

  const [start, databaseStarting, databaseReady, serverStarting] = events;
  assert.deepEqual(start, { type: "start" });
  assert.equal(databaseStarting.name, "database");
  assert.deepEqual(databaseStarting.dependsOn, []);
  assert.equal(databaseReady.name, "database");
  assert.equal(typeof databaseReady.durationMs, "number");
  assert.ok(databaseReady.durationMs >= 0);
  assert.deepEqual(serverStarting.dependsOn, ["database"]);
});

test("o evento resource:starting carrega uma cópia das dependências do registro", async () => {
  const events = [];
  const line = createLine(events);

  const dependsOn = ["database"];
  line.register({ name: "database", init: async () => {} });
  line.register({ name: "server", dependsOn, init: async () => {} });
  // Mutação posterior não afeta a configuração capturada no registro.
  dependsOn.push("cache");

  await line.start();

  const starting = events.find((event) => event.type === "resource:starting" && event.name === "server");
  assert.deepEqual(starting.dependsOn, ["database"]);
});

test("start() repetido durante a operação não duplica eventos", async () => {
  const events = [];
  const { line, tracked } = createApp(events);
  line.register(tracked("database"));

  const first = line.start();
  const second = line.start();
  await Promise.all([first, second]);

  assert.equal(events.filter((event) => event.type === "start").length, 1);
  assert.equal(events.filter((event) => event.type === "start:resolved").length, 1);
});

test("uma falha emite resource:failed, pulados, rollback e start:rejected", async () => {
  const events = [];
  const line = createLine(events);

  line.register({ name: "config", init: async () => {}, close: async () => {} });
  line.register({ name: "postgres", dependsOn: ["config"], init: async () => {}, close: async () => {} });
  line.register({
    name: "redis",
    dependsOn: ["config"],
    init: async () => {
      throw new Error("ETIMEDOUT redis:6379");
    },
    close: async () => {},
  });
  // Depende de redis (direto) e de config: pulado pelo ancestral que falhou.
  line.register({ name: "queue", dependsOn: ["redis", "config"], init: async () => {} });
  // Depende de queue, que depende de redis: pulado transitivamente.
  line.register({ name: "http", dependsOn: ["queue"], init: async () => {} });

  const error = await captureRejection(line.start());

  assert.match(error.message, /ETIMEDOUT redis:6379/);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "resource:starting",
      "resource:ready",
      "resource:starting",
      "resource:ready",
      "resource:starting",
      "resource:failed",
      "resources:skipped",
      "rollback",
      "close:start",
      "close:end",
      "close:start",
      "close:end",
      "start:rejected",
    ],
  );

  const skipped = events.find((event) => event.type === "resources:skipped");
  assert.deepEqual(skipped.names, ["queue", "http"]);
  assert.equal(skipped.failedResource, "redis");

  const rollback = events.find((event) => event.type === "rollback");
  assert.equal(rollback.count, 2);

  const closes = events.filter((event) => event.type === "close:start");
  assert.deepEqual(closes, [
    { type: "close:start", name: "postgres", reason: "rollback" },
    { type: "close:start", name: "config", reason: "rollback" },
  ]);

  const rejected = events.find((event) => event.type === "start:rejected");
  assert.equal(rejected.failedResource, "redis");
  assert.equal(rejected.closedCount, 2);
  assert.equal(rejected.leakedCount, 0);
  assert.equal(rejected.error, error);
});

test("um close() que falha durante o rollback vira close:end com error e conta como vazado", async () => {
  const events = [];
  const line = createLine(events);

  line.register({
    name: "a",
    init: async () => {},
    close: async () => {
      throw new Error("conexão travada");
    },
  });
  line.register({
    name: "b",
    init: async () => {
      throw new Error("b falhou");
    },
  });

  const error = await captureRejection(line.start());
  assert.ok(error instanceof AggregateError);

  const closed = events.filter((event) => event.type === "close:end");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].name, "a");
  assert.equal(closed[0].error.message, "conexão travada");
  assert.equal(typeof closed[0].durationMs, "number");

  const rejected = events.find((event) => event.type === "start:rejected");
  assert.equal(rejected.closedCount, 0);
  assert.equal(rejected.leakedCount, 1);
  assert.equal(rejected.error, error);
});

test("recurso sem close() não gera eventos de close nem conta como encerrado ou vazado", async () => {
  const events = [];
  const line = createLine(events);

  line.register({ name: "a", init: async () => {} });
  line.register({
    name: "b",
    init: async () => {
      throw new Error("b falhou");
    },
  });

  await captureRejection(line.start());

  assert.equal(events.some((event) => event.type === "close:start"), false);
  const rejected = events.find((event) => event.type === "start:rejected");
  assert.equal(rejected.closedCount, 0);
  assert.equal(rejected.leakedCount, 0);
});

test("recursos independentes que não chegaram a ser tentados emitem resources:aborted", async () => {
  const events = [];
  const { line, tracked } = createApp(events);

  line.register({
    name: "a",
    init: async () => {
      throw new Error("a falhou");
    },
  });
  line.register(tracked("b"));
  line.register(tracked("c", ["b"]));

  await captureRejection(line.start());

  const aborted = events.find((event) => event.type === "resources:aborted");
  assert.deepEqual(aborted.names, ["b", "c"]);
  assert.equal(events.some((event) => event.type === "resources:skipped"), false);
});

test("dependentes alcançados por vários caminhos não são contados em dobro no pulo", async () => {
  const events = [];
  const { line, tracked } = createApp(events);

  line.register({
    name: "a",
    init: async () => {
      throw new Error("a falhou");
    },
  });
  line.register(tracked("x"));
  line.register(tracked("b", ["x"]));
  line.register(tracked("c", ["b"]));
  // "e" alcança "b" por dois caminhos (direto e via "c"); o grafo andante
  // não deve re-visitá-lo nem recontá-lo.
  line.register(tracked("e", ["b", "c"]));

  await captureRejection(line.start());

  const aborted = events.find((event) => event.type === "resources:aborted");
  assert.deepEqual(aborted.names, ["x", "b", "c", "e"]);
});

test("falha no primeiro recurso não emite rollback nem eventos de close", async () => {
  const events = [];
  const { line } = createApp(events);

  line.register({
    name: "a",
    init: async () => {
      throw new Error("a falhou");
    },
  });

  await captureRejection(line.start());

  assert.equal(events.some((event) => event.type === "rollback"), false);
  assert.equal(events.some((event) => event.type === "close:start"), false);
  assert.deepEqual(events.map((event) => event.type), [
    "start",
    "resource:starting",
    "resource:failed",
    "start:rejected",
  ]);
});

test("um shutdown completo emite shutdown, close por recurso e shutdown:resolved", async () => {
  const events = [];
  const { line, tracked } = createApp(events);

  line.register(tracked("database"));
  line.register(tracked("server", ["database"]));

  await line.start();
  await line.shutdown();

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

  const closes = events.filter((event) => event.type === "close:start");
  assert.deepEqual(closes.map((event) => event.name), ["server", "database"]);
  assert.ok(closes.every((event) => event.reason === "shutdown"));

  const resolved = events.find((event) => event.type === "shutdown:resolved");
  assert.equal(typeof resolved.durationMs, "number");
});

test("um shutdown com falha de limpeza emite shutdown:rejected com o AggregateError", async () => {
  const events = [];
  const line = createLine(events);

  line.register({
    name: "a",
    init: async () => {},
    close: async () => {
      throw new Error("a não fechou");
    },
  });

  await line.start();
  const error = await captureRejection(line.shutdown());

  assert.ok(error instanceof AggregateError);
  const rejected = events.find((event) => event.type === "shutdown:rejected");
  assert.equal(rejected.errorCount, 1);
  assert.equal(rejected.error, error);
  assert.equal(events.some((event) => event.type === "shutdown:resolved"), false);
});

test("shutdown() após uma falha é no-op e não emite eventos", async () => {
  const events = [];
  const { line } = createApp(events);

  line.register({
    name: "a",
    init: async () => {
      throw new Error("a falhou");
    },
  });

  await captureRejection(line.start());
  events.length = 0;

  await line.shutdown();

  assert.deepEqual(events, []);
});

test("prettyLogger formata o fluxo de falha como no exemplo visual", async () => {
  const lines = [];
  const line = new LifeLine({ logger: prettyLogger({ colors: false, write: (l) => lines.push(l) }) });

  line.register({ name: "config", init: async () => {}, close: async () => {} });
  line.register({ name: "postgres", dependsOn: ["config"], init: async () => {}, close: async () => {} });
  line.register({
    name: "redis",
    dependsOn: ["config"],
    init: async () => {
      throw new Error("ETIMEDOUT redis:6379");
    },
  });
  line.register({ name: "queue", dependsOn: ["redis"], init: async () => {} });
  line.register({ name: "http", dependsOn: ["redis"], init: async () => {} });

  await captureRejection(line.start());

  assert.deepEqual(lines.map(normalize), [
    "app.start()",
    "config iniciando",
    "config no ar · Xs",
    "postgres iniciando (precisa de config)",
    "postgres no ar · Xs",
    "redis iniciando (precisa de config)",
    "redis falhou: ETIMEDOUT redis:6379",
    "queue, http ignorados: dependem de redis",
    "rollback: encerrando 2 em ordem inversa",
    "postgres encerrando",
    "postgres encerrado · Xs",
    "config encerrando",
    "config encerrado · Xs",
    "LifelineStartError: redis falhou · 2 encerrados · 0 vazaram",
  ]);
});

test("prettyLogger formata falhas de init() e de close() não-Error", async () => {
  const lines = [];
  const line = new LifeLine({ logger: prettyLogger({ colors: false, write: (l) => lines.push(l) }) });

  line.register({
    name: "a",
    init: async () => {},
    close: async () => {
      throw "stringo";
    },
  });
  line.register({
    name: "b",
    init: async () => {
      throw "stringo";
    },
  });

  await captureRejection(line.start());

  assert.deepEqual(lines.map(normalize), [
    "app.start()",
    "a iniciando",
    "a no ar · Xs",
    "b iniciando",
    "b falhou: stringo",
    "rollback: encerrando 1 em ordem inversa",
    "a encerrando",
    "a não encerrou: stringo",
    "LifelineStartError: b falhou · 0 encerrados · 1 vazaram",
  ]);
});

test("prettyLogger formata o encerramento gracioso e recursos independentes pulados", async () => {
  const lines = [];
  const line = new LifeLine({ logger: prettyLogger({ colors: false, write: (l) => lines.push(l) }) });

  line.register({ name: "a", init: async () => {}, close: async () => {} });
  line.register({ name: "b", init: async () => {}, close: async () => {} });

  await line.start();
  await line.shutdown();

  assert.deepEqual(lines.map(normalize), [
    "app.start()",
    "a iniciando",
    "a no ar · Xs",
    "b iniciando",
    "b no ar · Xs",
    "app no ar · Xs",
    "app.shutdown()",
    "b encerrando",
    "b encerrado · Xs",
    "a encerrando",
    "a encerrado · Xs",
    "app encerrado · Xs",
  ]);
});

test("prettyLogger colore cada tipo de linha e aceita erro não-Error no init()", async () => {
  const lines = [];
  const line = new LifeLine({ logger: prettyLogger({ colors: true, write: (l) => lines.push(l) }) });

  line.register({ name: "a", init: async () => {} });
  line.register({
    name: "b",
    dependsOn: ["a"],
    init: async () => {
      throw 42;
    },
  });

  await captureRejection(line.start());

  // Timestamp sempre esmaecido; mensagens coloridas por severidade.
  assert.ok(lines.every((l) => /^\u001b\[2m\+\d+\.\d\ds\u001b\[0m {4}/.test(l)));
  assert.ok(lines.some((l) => l.includes("\u001b[1mapp.start()\u001b[0m")));
  assert.ok(lines.some((l) => l.includes("\u001b[32ma no ar")));
  assert.ok(lines.some((l) => l.includes("\u001b[31mb falhou: 42\u001b[0m")));
  assert.ok(lines.some((l) => l.includes("\u001b[31mLifelineStartError: b falhou · 0 encerrados · 0 vazaram\u001b[0m")));
});

test("prettyLogger formata recursos abortados e falha de encerramento", async () => {
  const abortedLines = [];
  const aborted = new LifeLine({
    logger: prettyLogger({ colors: false, write: (l) => abortedLines.push(l) }),
  });
  aborted.register({
    name: "a",
    init: async () => {
      throw new Error("a falhou");
    },
  });
  aborted.register({ name: "b", init: async () => {} });

  await captureRejection(aborted.start());
  const abortedLine = abortedLines.find((l) => l.includes("ignorados"));
  assert.equal(normalize(abortedLine), "b ignorados: inicialização abortada");

  const shutdownLines = [];
  const failing = new LifeLine({
    logger: prettyLogger({ colors: false, write: (l) => shutdownLines.push(l) }),
  });
  failing.register({
    name: "a",
    init: async () => {},
    close: async () => {
      throw new Error("conexão travada");
    },
  });

  await failing.start();
  await captureRejection(failing.shutdown());

  assert.deepEqual(shutdownLines.map(normalize), [
    "app.start()",
    "a iniciando",
    "a no ar · Xs",
    "app no ar · Xs",
    "app.shutdown()",
    "a encerrando",
    "a não encerrou: conexão travada",
    "ShutdownError: 1 recursos não fecharam",
  ]);
});

test("prettyLogger liga cores por padrão quando há TTY e desliga com NO_COLOR", () => {
  const originalTTY = process.stdout.isTTY;
  const originalNoColor = process.env.NO_COLOR;

  try {
    process.stdout.isTTY = true;
    delete process.env.NO_COLOR;

    const colored = [];
    prettyLogger({ write: (l) => colored.push(l) })({ type: "shutdown" });
    assert.ok(colored[0].includes("\u001b[1mapp.shutdown()\u001b[0m"));

    process.env.NO_COLOR = "1";

    const plain = [];
    prettyLogger({ write: (l) => plain.push(l) })({ type: "shutdown" });
    assert.equal(plain[0].includes("\u001b"), false);
  } finally {
    process.stdout.isTTY = originalTTY;
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  }
});

test("prettyLogger escreve no stdout por padrão", () => {
  const originalWrite = process.stdout.write;
  const captured = [];
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };

  try {
    prettyLogger({ colors: false })({ type: "shutdown" });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.deepEqual(captured, ["+0.00s    app.shutdown()\n"]);
});

test("LifeLine sem logger continua funcionando sem gerar saída", async () => {
  const line = new LifeLine();

  line.register({ name: "a", init: async () => {}, close: async () => {} });

  await line.start();
  await line.shutdown();

  assert.equal(line.state, "stopped");
});
