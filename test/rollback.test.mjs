import test from "node:test";
import assert from "node:assert/strict";

import { LifeLine, CleanupError } from "../dist/index.js";

import { captureRejection } from "./_helpers.mjs";


test("quando um init() falha, os recursos inicializados são fechados na ordem inversa", async () => {
  const log = [];
  const line = new LifeLine();

  const tracked = (name) => ({
    name,
    init: async () => log.push(`init:${name}`),
    close: async () => log.push(`close:${name}`),
  });

  line.register(tracked("a"));
  line.register(tracked("b"));
  line.register({
    name: "c",
    init: async () => {
      log.push("init:c");
      throw new Error("init de c falhou");
    },
    close: async () => log.push("close:c"),
  });

  await assert.rejects(line.start(), /init de c falhou/);

  // c nunca concluiu o init, então não recebe close().
  assert.deepEqual(log, ["init:a", "init:b", "init:c", "close:b", "close:a"]);
});

test("o rollback continua mesmo quando algum close() falha", async () => {
  const log = [];
  const line = new LifeLine();

  line.register({
    name: "a",
    init: async () => log.push("init:a"),
    close: async () => log.push("close:a"),
  });
  line.register({
    name: "b",
    init: async () => log.push("init:b"),
    close: async () => {
      log.push("close:b");
      throw new Error("close de b falhou");
    },
  });
  // Recurso sem close() não interrompe o rollback.
  line.register({
    name: "c",
    init: async () => log.push("init:c"),
  });
  line.register({
    name: "d",
    init: async () => {
      log.push("init:d");
      throw new Error("init de d falhou");
    },
  });

  await assert.rejects(line.start());

  // b falha ao fechar, mas a ainda é fechado.
  assert.deepEqual(log, ["init:a", "init:b", "init:c", "init:d", "close:b", "close:a"]);
});

test("sem erros de limpeza, o erro original da inicialização chega intacto", async () => {
  const original = new Error("falha raiz");
  const line = new LifeLine();

  line.register({ name: "a", init: async () => {} });
  line.register({
    name: "b",
    init: async () => {
      throw original;
    },
  });

  await assert.rejects(line.start(), (error) => {
    assert.strictEqual(error, original);
    return true;
  });
});

test("com erros de limpeza, o erro original é preservado como causa", async () => {
  const original = new Error("falha raiz");
  const line = new LifeLine();

  line.register({
    name: "a",
    init: async () => {},
    close: async () => {
      throw new Error("close de a falhou");
    },
  });
  line.register({
    name: "b",
    init: async () => {
      throw original;
    },
  });

  await assert.rejects(line.start(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.strictEqual(error.cause, original);
    return true;
  });
});

test("os erros de limpeza são identificáveis por recurso", async () => {
  const closeFailure = new Error("close de a falhou");
  const line = new LifeLine();

  line.register({
    name: "a",
    init: async () => {},
    close: async () => {
      throw closeFailure;
    },
  });
  line.register({
    name: "b",
    init: async () => {},
    close: async () => {
      throw new Error("close de b falhou");
    },
  });
  line.register({
    name: "c",
    init: async () => {
      throw new Error("falha raiz");
    },
  });

  await assert.rejects(line.start(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);

    const porRecurso = new Map(
      error.errors.map((cleanupError) => [cleanupError.resourceName, cleanupError]),
    );

    const cleanupA = porRecurso.get("a");
    assert.ok(cleanupA instanceof CleanupError);
    assert.strictEqual(cleanupA.cause, closeFailure);

    const cleanupB = porRecurso.get("b");
    assert.ok(cleanupB instanceof CleanupError);
    assert.match(cleanupB.message, /b/);
    return true;
  });
});

test("recursos sem close() não interrompem o rollback", async () => {
  const log = [];
  const line = new LifeLine();

  // a e b não declaram close().
  line.register({ name: "a", init: async () => log.push("init:a") });
  line.register({
    name: "b",
    init: async () => log.push("init:b"),
    close: async () => log.push("close:b"),
  });
  line.register({
    name: "c",
    init: async () => {
      log.push("init:c");
      throw new Error("falha raiz");
    },
  });

  await assert.rejects(line.start(), /falha raiz/);

  // O rollback pulou "a" (sem close) e fechou "b" normalmente.
  assert.deepEqual(log, ["init:a", "init:b", "init:c", "close:b"]);
});

test("valores que não são Error são preservados em cause quando a limpeza falha", async () => {
  const nonError = "falha não Error";
  const line = new LifeLine();

  line.register({
    name: "a",
    init: async () => {},
    close: async () => {
      throw new Error("close de a falhou");
    },
  });
  line.register({
    name: "b",
    init: async () => {
      throw nonError;
    },
  });

  const rejection = await line.start().then(
    () => assert.fail("start() deveria ter rejeitado"),
    (error) => error,
  );

  assert.ok(rejection instanceof AggregateError);
  assert.strictEqual(rejection.cause, nonError);
});

test("rollback com falha de limpeza preserva o erro de init e todos os erros de fechamento", async () => {
  const original = new Error("falha raiz");
  const closeA = new Error("close de a falhou");
  const closeB = new Error("close de b falhou");
  const line = new LifeLine();

  line.register({
    name: "a",
    init: async () => {},
    close: async () => {
      throw closeA;
    },
  });
  line.register({
    name: "b",
    init: async () => {},
    close: async () => {
      throw closeB;
    },
  });
  line.register({
    name: "c",
    init: async () => {
      throw original;
    },
  });

  const rejection = await captureRejection(line.start());

  // A causa raiz da inicialização...
  assert.ok(rejection instanceof AggregateError);
  assert.strictEqual(rejection.cause, original);

  // ...e cada erro de fechamento, na ordem inversa em que seriam chamados.
  assert.equal(rejection.errors.length, 2);
  const causePorRecurso = new Map(
    rejection.errors.map((cleanupError) => [cleanupError.resourceName, cleanupError.cause]),
  );
  assert.strictEqual(causePorRecurso.get("b"), closeB);
  assert.strictEqual(causePorRecurso.get("a"), closeA);
});

test("após falha de limpeza no rollback, o estado é failed e shutdown() não repete a limpeza", async () => {
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
  line.register({
    name: "b",
    init: async () => {
      throw new Error("falha raiz");
    },
  });

  const rejection = await captureRejection(line.start());
  assert.match(rejection.cause.message, /falha raiz/);

  assert.equal(line.state, "failed");
  assert.equal(closeCalls, 1);

  // Política v1: não repetir automaticamente a limpeza, mesmo com falha.
  await line.shutdown();
  assert.equal(closeCalls, 1);
  assert.equal(line.state, "failed");
});

test("init() que lança um não-Error com rollback limpo rejeita com o valor original", async () => {
  const line = new LifeLine();

  line.register({ name: "a", init: async () => {} });
  line.register({
    name: "b",
    init: async () => {
      throw "falha não Error";
    },
  });

  const rejection = await captureRejection(line.start());

  // Sem erros de limpeza, o valor chega como está: sem embrulho, sem conversão.
  assert.strictEqual(rejection, "falha não Error");
});
