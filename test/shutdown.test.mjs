import test from "node:test";
import assert from "node:assert/strict";

import { LifeLine, CleanupError } from "../dist/index.js";

import { captureRejection } from "./_helpers.mjs";


test("shutdown() fecha os recursos na ordem inversa", async () => {
  const log = [];
  const line = new LifeLine();

  const tracked = (name) => ({
    name,
    init: async () => log.push(`init:${name}`),
    close: async () => log.push(`close:${name}`),
  });

  line.register(tracked("a"));
  line.register(tracked("b"));
  line.register(tracked("c"));

  await line.start();
  assert.equal(line.state, "running");

  await line.shutdown();

  assert.deepEqual(log, ["init:a", "init:b", "init:c", "close:c", "close:b", "close:a"]);
  assert.equal(line.state, "stopped");
});

test("uma falha em close() não impede a limpeza dos demais recursos", async () => {
  const log = [];
  const line = new LifeLine();

  const tracked = (name) => ({
    name,
    init: async () => log.push(`init:${name}`),
    close: async () => log.push(`close:${name}`),
  });

  line.register(tracked("a"));
  line.register({
    name: "b",
    init: async () => log.push("init:b"),
    close: async () => {
      log.push("close:b");
      throw new Error("close de b falhou");
    },
  });
  line.register(tracked("c"));

  await line.start();
  await assert.rejects(line.shutdown(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    const [cleanupError] = error.errors;
    assert.ok(cleanupError instanceof CleanupError);
    assert.equal(cleanupError.resourceName, "b");
    return true;
  });

  // Todos os recursos foram tentados, mesmo com b falhando.
  assert.deepEqual(log, ["init:a", "init:b", "init:c", "close:c", "close:b", "close:a"]);
  assert.equal(line.state, "stopped");
});

test("duas chamadas simultâneas a shutdown() não duplicam os fechamentos", async () => {
  const closeCalls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const line = new LifeLine();
  line.register({
    name: "a",
    init: async () => {},
    close: async () => {
      await gate;
      closeCalls.push("a");
    },
  });

  await line.start();

  const first = line.shutdown();
  const second = line.shutdown();
  release();
  await Promise.all([first, second]);

  assert.deepEqual(closeCalls, ["a"]);
});

test("chamadas posteriores ao encerramento não repetem a limpeza", async () => {
  let closeCalls = 0;
  const line = new LifeLine();

  line.register({
    name: "a",
    init: async () => {},
    close: async () => {
      closeCalls += 1;
    },
  });

  await line.start();
  await line.shutdown();
  await line.shutdown();

  assert.equal(closeCalls, 1);
});

test("shutdown() antes de start() encerra sem inicializar nada e vira estado terminal", async () => {
  const log = [];
  const line = new LifeLine();

  line.register({ name: "a", init: async () => log.push("init:a") });

  await line.shutdown();

  assert.equal(line.state, "stopped");
  assert.deepEqual(log, []);

  // Estado terminal: nem init nem registro são mais permitidos.
  assert.throws(() => line.start(), /encerrado/);
  assert.throws(() => line.register({ name: "b", init: async () => {} }), /fora do estado inicial/);

  // Chamadas posteriores não repetem nem falham.
  await line.shutdown();
});

test("shutdown() durante a inicialização falha de forma definida", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const line = new LifeLine();
  line.register({
    name: "a",
    init: async () => {
      await gate;
    },
  });

  const starting = line.start();
  assert.throws(() => line.shutdown(), /inicialização/);

  // A rejeição não toca no estado nem em shutdownPromise: a operação
  // de encerramento continua disponível para depois.
  assert.equal(line.state, "starting");

  // Depois de a inicialização terminar, o encerramento funciona.
  release();
  await starting;
  await line.shutdown();
  assert.equal(line.state, "stopped");
});

test("shutdown() após falha na inicialização é um no-op que resolve", async () => {
  const line = new LifeLine();
  line.register({
    name: "a",
    init: async () => {
      throw new Error("falha raiz");
    },
  });

  await assert.rejects(line.start(), /falha raiz/);
  assert.equal(line.state, "failed");

  // O rollback já limpou o que existia; shutdown não lança nem repete limpeza.
  await line.shutdown();
  assert.equal(line.state, "failed");
});

test("duas chamadas concorrentes a shutdown() com falha recebem a mesma rejeição", async () => {
  let closeCalls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const line = new LifeLine();

  line.register({
    name: "a",
    init: async () => {},
    close: async () => {
      await gate;
      closeCalls += 1;
      throw new Error("close de a falhou");
    },
  });

  await line.start();

  const first = line.shutdown();
  const second = line.shutdown();
  release();

  const [errorFirst, errorSecond] = await Promise.all([
    captureRejection(first),
    captureRejection(second),
  ]);

  // Uma única tentativa de close(), e a mesma rejeição (identidade) para ambos.
  assert.equal(closeCalls, 1);
  assert.strictEqual(errorFirst, errorSecond);
  assert.ok(errorFirst instanceof AggregateError);
  assert.equal(line.state, "stopped");

  // Diagnóstico: chamadas posteriores devolvem a mesma rejeição, sem perder os erros.
  const later = await captureRejection(line.shutdown());
  assert.strictEqual(later, errorFirst);
  assert.equal(closeCalls, 1);
});

test("start() depois de shutdown() ter começado falha sem inicializar nada", async () => {
  const log = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const line = new LifeLine();

  line.register({
    name: "a",
    init: async () => log.push("init:a"),
    close: async () => {
      await gate;
      log.push("close:a");
    },
  });

  await line.start();

  const stopping = line.shutdown();
  assert.equal(line.state, "stopping");

  // Durante o encerramento.
  assert.throws(() => line.start(), /encerrado/);

  release();
  await stopping;

  // Depois de concluído.
  assert.equal(line.state, "stopped");
  assert.throws(() => line.start(), /encerrado/);

  // Nada foi inicializado (nem re-inicializado) em nenhuma das tentativas.
  assert.deepEqual(log, ["init:a", "close:a"]);
});

test("shutdown() com falha devolve a mesma Promise rejeitada em chamadas posteriores", async () => {
  let closeCalls = 0;
  const line = new LifeLine();

  line.register({
    name: "a",
    init: async () => {},
    close: async () => {
      closeCalls += 1;
      throw new Error("close de a falhou");
    },
  });

  await line.start();

  const first = line.shutdown();
  const firstError = await captureRejection(first);

  // Mesma Promise (identidade), sem novo fechamento.
  const later = line.shutdown();
  assert.strictEqual(later, first);

  const laterError = await captureRejection(later);
  assert.strictEqual(laterError, firstError);
  assert.ok(laterError instanceof AggregateError);
  assert.equal(closeCalls, 1);
});

test("shutdown() dentro de init() sem tratativa falha a inicialização e aciona o rollback", async () => {
  const log = [];
  const line = new LifeLine();

  const tracked = (name) => ({
    name,
    init: async () => log.push(`init:${name}`),
    close: async () => log.push(`close:${name}`),
  });

  line.register(tracked("a"));
  line.register({
    name: "b",
    init: async () => {
      log.push("init:b");
      // Recurso tenta encerrar o gerenciador durante a própria inicialização.
      await line.shutdown();
    },
  });

  const rejection = await captureRejection(line.start());

  // O shutdown() lançado dentro de init() não é tratado pelo recurso:
  // o init() de b falha, b não conclui (sem close() nele) e o rollback
  // fecha apenas a — comportamento intencional, não acidental.
  assert.match(rejection.message, /inicialização/);
  assert.equal(line.state, "failed");
  assert.deepEqual(log, ["init:a", "init:b", "close:a"]);

  // O shutdown() interno não envenenou shutdownPromise: o encerramento
  // posterior segue como no-op do estado failed.
  await line.shutdown();
  assert.deepEqual(log, ["init:a", "init:b", "close:a"]);
});

test("shutdown() agrega vários erros de close() e continua a limpeza", async () => {
  const log = [];
  const line = new LifeLine();

  const failingClose = (name) => ({
    name,
    init: async () => {},
    close: async () => {
      log.push(`close:${name}`);
      throw new Error(`falha ao fechar ${name}`);
    },
  });

  line.register(failingClose("a"));
  line.register(failingClose("b"));
  line.register(failingClose("c"));

  await line.start();
  const rejection = await captureRejection(line.shutdown());

  // Todos os close() foram tentados, na ordem inversa...
  assert.deepEqual(log, ["close:c", "close:b", "close:a"]);

  // ...e todos os erros foram agregados, preservando a ordem.
  assert.ok(rejection instanceof AggregateError);
  assert.equal(rejection.errors.length, 3);
  assert.deepEqual(
    rejection.errors.map((cleanupError) => cleanupError.resourceName),
    ["c", "b", "a"],
  );
  assert.equal(line.state, "stopped");
});
