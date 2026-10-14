import test from "node:test";
import assert from "node:assert/strict";

import { LifeLine } from "../dist/index.js";

import { createResource, captureRejection } from "./_helpers.mjs";


test("inicializa todos os recursos registrados", async () => {
  const log = [];
  const line = new LifeLine();

  line.register(createResource("database", log));
  line.register(createResource("http-server", log));
  line.register(createResource("queue-consumer", log));

  await line.start();

  assert.deepEqual(log, ["database", "http-server", "queue-consumer"]);
});

test("cada recurso tem seu init() chamado exatamente uma vez", async () => {
  const calls = new Map();
  const count = (name) => calls.set(name, (calls.get(name) ?? 0) + 1);

  const line = new LifeLine();
  line.register({ name: "a", init: async () => count("a") });
  line.register({ name: "b", init: async () => count("b") });

  await line.start();

  assert.equal(calls.get("a"), 1);
  assert.equal(calls.get("b"), 1);
});

test("os recursos são inicializados na ordem em que foram registrados", async () => {
  const log = [];
  const line = new LifeLine();

  // O primeiro recurso demora mais; se a inicialização fosse paralela,
  // ele terminaria depois do segundo.
  line.register(createResource("lento", log, 30));
  line.register(createResource("rapido", log));

  await line.start();

  assert.deepEqual(log, ["lento", "rapido"]);
});

test("chamar start() novamente não inicializa os recursos outra vez", async () => {
  let initCalls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const line = new LifeLine();
  line.register({
    name: "lento",
    init: async () => {
      initCalls += 1;
      await gate;
    },
  });

  // Duas chamadas concorrentes: a segunda recebe exatamente a mesma
  // Promise e deve aguardar a mesma operação.
  const first = line.start();
  const second = line.start();
  assert.strictEqual(second, first);
  release();
  await Promise.all([first, second]);

  // Uma chamada após a conclusão também não deve reinicializar.
  await line.start();

  assert.equal(initCalls, 1);
});

test("chamadas concorrentes a start() compartilham a falha sem reinicializar", async () => {
  let initCalls = 0;
  let rejectInit;
  const gate = new Promise((resolve, reject) => {
    rejectInit = reject;
  });

  const line = new LifeLine();
  line.register({
    name: "instavel",
    init: async () => {
      initCalls += 1;
      await gate;
    },
  });

  const original = new Error("init instável");
  const first = line.start();
  const second = line.start();
  rejectInit(original);

  const [errorFirst, errorSecond] = await Promise.all([
    first.then(
      () => assert.fail("first deveria rejeitar"),
      (error) => error,
    ),
    second.then(
      () => assert.fail("second deveria rejeitar"),
      (error) => error,
    ),
  ]);

  // Uma única inicialização, e a mesma falha para ambos os chamadores.
  assert.equal(initCalls, 1);
  assert.strictEqual(errorFirst, original);
  assert.strictEqual(errorSecond, original);
});

test("init() que chama start() de forma reentrante compartilha a mesma operação", async () => {
  const log = [];
  const line = new LifeLine();
  let reentrant;

  line.register({
    name: "a",
    init: async () => {
      log.push("init:a");
      // Chamada reentrante: acontece enquanto initializeAll ainda está
      // configurando sua própria Promise.
      reentrant = line.start();
      log.push("init:a:reentrant");
    },
  });
  line.register({ name: "b", init: async () => log.push("init:b") });

  const outer = line.start();
  assert.equal(line.state, "starting");

  await outer;

  // A chamada reentrante recebeu exatamente a mesma Promise da operação.
  assert.strictEqual(reentrant, outer);
  assert.equal(line.state, "running");
  assert.deepEqual(log, ["init:a", "init:a:reentrant", "init:b"]);
});

test("start() depois de uma falha concluída devolve a mesma operação rejeitada", async () => {
  const line = new LifeLine();

  line.register({
    name: "a",
    init: async () => {
      throw new Error("falha raiz");
    },
  });

  const first = line.start();
  const firstError = await captureRejection(first);

  // Chamada depois de a falha já ter acontecido: mesma Promise, mesmo erro.
  const later = line.start();
  assert.strictEqual(later, first);

  const laterError = await captureRejection(later);
  assert.strictEqual(laterError, firstError);
  assert.equal(line.state, "failed");
});

test("três chamadas concorrentes a start() compartilham a mesma operação", async () => {
  let initCalls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const line = new LifeLine();

  line.register({
    name: "a",
    init: async () => {
      initCalls += 1;
      await gate;
    },
  });

  const calls = [line.start(), line.start(), line.start()];
  assert.strictEqual(calls[1], calls[0]);
  assert.strictEqual(calls[2], calls[0]);

  release();
  await Promise.all(calls);

  assert.equal(initCalls, 1);
  assert.equal(line.state, "running");
});
