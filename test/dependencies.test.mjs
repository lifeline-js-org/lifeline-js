import test from "node:test";
import assert from "node:assert/strict";

import { LifeLine } from "../dist/index.js";

test("dependências são inicializadas antes dos dependentes, mesmo com outro registro", async () => {
  const log = [];
  const line = new LifeLine();

  line.register({
    name: "http-server",
    dependsOn: ["database"],
    init: async () => log.push("http-server"),
  });
  line.register({ name: "database", init: async () => log.push("database") });

  await line.start();

  assert.deepEqual(log, ["database", "http-server"]);
});

test("dependências em diamante inicializam o recurso comum uma única vez", async () => {
  const log = [];
  const line = new LifeLine();

  line.register({
    name: "app",
    dependsOn: ["api", "worker"],
    init: async () => log.push("app"),
  });
  line.register({
    name: "api",
    dependsOn: ["database"],
    init: async () => log.push("api"),
  });
  line.register({
    name: "worker",
    dependsOn: ["database"],
    init: async () => log.push("worker"),
  });
  line.register({ name: "database", init: async () => log.push("database") });

  await line.start();

  assert.deepEqual(log, ["database", "api", "worker", "app"]);
});

test("dependência inexistente falha antes de qualquer init()", async () => {
  const log = [];
  const line = new LifeLine();

  line.register({
    name: "http-server",
    dependsOn: ["database"],
    init: async () => log.push("http-server"),
  });

  assert.throws(() => line.start(), /database/);

  // Nenhum init() rodou, e o gerenciador não foi envenenado.
  assert.deepEqual(log, []);
  assert.equal(line.state, "created");

  // Registrando a dependência ausente, uma nova tentativa funciona.
  line.register({ name: "database", init: async () => log.push("database") });
  await line.start();
  assert.deepEqual(log, ["database", "http-server"]);
});

test("ciclo de dependência é rejeitado antes de qualquer init()", async () => {
  const log = [];
  const line = new LifeLine();

  line.register({ name: "a", dependsOn: ["b"], init: async () => log.push("a") });
  line.register({ name: "b", dependsOn: ["a"], init: async () => log.push("b") });

  assert.throws(
    () => line.start(),
    (error) => {
      assert.match(error.message, /Ciclo de dependência/);
      assert.match(error.message, /a/);
      assert.match(error.message, /b/);
      return true;
    },
  );

  assert.deepEqual(log, []);
  assert.equal(line.state, "created");
});

test("auto-dependência é tratada como ciclo", async () => {
  const line = new LifeLine();
  line.register({ name: "a", dependsOn: ["a"], init: async () => {} });

  assert.throws(() => line.start(), /Ciclo de dependência/);
  assert.equal(line.state, "created");
});

test("após erro de ciclo, o estado permanece created sem inicializar nada", async () => {
  const log = [];
  const line = new LifeLine();

  line.register({ name: "a", dependsOn: ["b"], init: async () => log.push("a") });
  line.register({ name: "b", dependsOn: ["a"], init: async () => log.push("b") });

  assert.throws(() => line.start(), /Ciclo de dependência/);
  assert.equal(line.state, "created");
  assert.deepEqual(log, []);

  // A configuração é copiada no registro: corrigir um ciclo exige ajustar
  // o código e criar uma nova instância — ver teste de dependsOn imutável.
});

test("dependências duplicadas são rejeitadas como configuração inválida", async () => {
  const log = [];
  const line = new LifeLine();

  line.register({
    name: "app",
    dependsOn: ["database", "database"],
    init: async () => log.push("app"),
  });
  line.register({ name: "database", init: async () => log.push("database") });

  assert.throws(() => line.start(), /duplicada em "app": "database"/);
  assert.deepEqual(log, []);
  assert.equal(line.state, "created");
});

test("ciclo de três recursos é rejeitado e o erro identifica o caminho", () => {
  const line = new LifeLine();

  line.register({ name: "a", dependsOn: ["b"], init: async () => {} });
  line.register({ name: "b", dependsOn: ["c"], init: async () => {} });
  line.register({ name: "c", dependsOn: ["a"], init: async () => {} });

  assert.throws(
    () => line.start(),
    (error) => {
      assert.match(error.message, /^Ciclo de dependência detectado: a → b → c → a$/);
      return true;
    },
  );
  assert.equal(line.state, "created");
});

test("alterar dependsOn após register() não afeta a ordem de inicialização", async () => {
  const log = [];
  const line = new LifeLine();

  const database = { name: "database", init: async () => log.push("database") };
  const httpServer = {
    name: "http-server",
    dependsOn: ["database"],
    init: async () => log.push("http-server"),
  };

  line.register(httpServer);
  line.register(database);

  // Mutação externa após o registro: a configuração já foi copiada.
  httpServer.dependsOn = [];

  await line.start();

  assert.deepEqual(log, ["database", "http-server"]);
});

test("alterar name após register() não afeta a validação", async () => {
  const line = new LifeLine();

  const resource = {
    name: "a",
    dependsOn: ["missing"],
    init: async () => {},
  };
  line.register(resource);
  resource.name = "zzz";

  assert.throws(() => line.start(), /"a" depende de "missing"/);
  assert.equal(line.state, "created");
});

test("init() e close() executam no objeto original registrado", async () => {
  const events = [];
  const line = new LifeLine();

  const resource = {
    name: "a",
    counter: 0,
    async init() {
      this.counter += 1;
      events.push(`init:${this.counter}`);
    },
    async close() {
      events.push(`close:${this.counter}`);
    },
  };

  line.register(resource);
  await line.start();
  await line.shutdown();

  // O `this` é o objeto original: o estado mutado por init() é visível em close().
  assert.deepEqual(events, ["init:1", "close:1"]);
  assert.equal(resource.counter, 1);
});

test("cadeia longa de dependências inicializa na ordem correta", async () => {
  const size = 1000;
  const line = new LifeLine();
  const order = [];

  // Registrado do topo para a base: o DFS precisa recorrer `size` níveis,
  // exercitando o limite de profundidade documentado como limitação v1.
  for (let i = size - 1; i >= 0; i -= 1) {
    line.register({
      name: `resource-${i}`,
      dependsOn: i === 0 ? [] : [`resource-${i - 1}`],
      init: async () => order.push(i),
    });
  }

  await line.start();

  assert.deepEqual(
    order,
    Array.from({ length: size }, (_, i) => i),
  );
});

test("o rollback fecha na ordem inversa da inicialização efetiva", async () => {
  const log = [];
  const line = new LifeLine();

  // Registro propositalmente de trás para frente: a ordem efetiva
  // vem das dependências, não do registro.
  line.register({
    name: "c",
    dependsOn: ["b"],
    init: async () => {
      log.push("init:c");
      throw new Error("falha em c");
    },
    close: async () => log.push("close:c"),
  });
  line.register({
    name: "b",
    dependsOn: ["a"],
    init: async () => log.push("init:b"),
    close: async () => log.push("close:b"),
  });
  line.register({
    name: "a",
    init: async () => log.push("init:a"),
    close: async () => log.push("close:a"),
  });

  await assert.rejects(line.start(), /falha em c/);

  // Efetiva: a → b → c. Rollback: close:b, close:a.
  assert.deepEqual(log, ["init:a", "init:b", "init:c", "close:b", "close:a"]);
});

test("o encerramento fecha na ordem inversa da inicialização efetiva", async () => {
  const log = [];
  const line = new LifeLine();

  line.register({
    name: "c",
    dependsOn: ["b"],
    init: async () => log.push("init:c"),
    close: async () => log.push("close:c"),
  });
  line.register({
    name: "b",
    dependsOn: ["a"],
    init: async () => log.push("init:b"),
    close: async () => log.push("close:b"),
  });
  line.register({
    name: "a",
    init: async () => log.push("init:a"),
    close: async () => log.push("close:a"),
  });

  await line.start();
  await line.shutdown();

  assert.deepEqual(log, ["init:a", "init:b", "init:c", "close:c", "close:b", "close:a"]);
});
