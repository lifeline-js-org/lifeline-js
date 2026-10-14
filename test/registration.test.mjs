import test from "node:test";
import assert from "node:assert/strict";

import { LifeLine } from "../dist/index.js";


test("registrar dois recursos com o mesmo nome gera um erro", () => {
  const line = new LifeLine();

  line.register({ name: "database", init: async () => {} });

  assert.throws(() => line.register({ name: "database", init: async () => {} }), /database/);
});

test("register() depois de start() deve falhar", async () => {
  const line = new LifeLine();
  line.register({ name: "a", init: async () => {} });

  // Durante a inicialização.
  const starting = line.start();
  assert.throws(() => line.register({ name: "b", init: async () => {} }), /fora do estado inicial/);
  await starting;

  // Depois de concluída.
  assert.throws(() => line.register({ name: "c", init: async () => {} }), /fora do estado inicial/);
});

test("register() rejeita nomes vazios e nomes só com espaços", () => {
  const line = new LifeLine();

  assert.throws(
    () => line.register({ name: "", init: async () => {} }),
    /não pode ser vazio/,
  );
  assert.throws(
    () => line.register({ name: "   ", init: async () => {} }),
    /não pode ser vazio/,
  );
});

test("register() rejeita espaços nas bordas mas permite espaços internos", async () => {
  const log = [];
  const line = new LifeLine();

  assert.throws(
    () => line.register({ name: " db", init: async () => {} }),
    /não pode começar nem terminar com espaço/,
  );
  assert.throws(
    () => line.register({ name: "db ", init: async () => {} }),
    /não pode começar nem terminar com espaço/,
  );

  // Espaços internos não atrapalham a resolução de dependências.
  line.register({
    name: "my db",
    init: async () => log.push("my db"),
  });
  line.register({
    name: "app",
    dependsOn: ["my db"],
    init: async () => log.push("app"),
  });

  await line.start();
  assert.deepEqual(log, ["my db", "app"]);
});

test("register() é rejeitado em todos os estados fora de created", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const line = new LifeLine();
  const attempt = () => line.register({ name: "x", init: async () => {} });

  line.register({
    name: "a",
    init: async () => {
      await gate;
    },
  });

  // starting
  const starting = line.start();
  assert.throws(attempt, /fora do estado inicial/);

  release();
  await starting;

  // running
  assert.throws(attempt, /fora do estado inicial/);

  // stopping
  const stopping = line.shutdown();
  assert.throws(attempt, /fora do estado inicial/);
  await stopping;

  // stopped
  assert.throws(attempt, /fora do estado inicial/);

  // failed
  const failing = new LifeLine();
  failing.register({
    name: "a",
    init: async () => {
      throw new Error("falha");
    },
  });
  await assert.rejects(failing.start());
  assert.throws(
    () => failing.register({ name: "x", init: async () => {} }),
    /fora do estado inicial/,
  );
});
