// Dependências entre recursos: toda dependência é inicializada antes de
// quem depende dela, e o encerramento inverte a ordem efetiva.
//
//   node examples/dependencies.js
import { LifeLine } from "lifeline.js";

const app = new LifeLine();

// Registrado ANTES da database de propósito: a ordem de registro não
// importa quando há dependsOn — o Lifeline resolve a ordem topológica.
app.register({
  name: "server",
  dependsOn: ["database"],
  async init() {
    console.log("server: iniciado");
  },
  async close() {
    console.log("server: parado");
  },
});

app.register({
  name: "queue-consumer",
  dependsOn: ["database"],
  async init() {
    console.log("queue-consumer: consumindo");
  },
  async close() {
    console.log("queue-consumer: parado");
  },
});

app.register({
  name: "database",
  async init() {
    console.log("database: conectado");
  },
  async close() {
    console.log("database: desconectado");
  },
});

// Saída esperada:
//   init:  database → server → queue-consumer
//   close: queue-consumer → server → database
await app.start();
await app.shutdown();
