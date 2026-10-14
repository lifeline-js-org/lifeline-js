// Exemplo básico: registrar recursos, iniciar e encerrar.
//
//   node examples/basic.js
import { LifeLine } from "lifeline.js";

const app = new LifeLine();

app.register({
  name: "database",
  async init() {
    // Na prática: await db.connect(process.env.DATABASE_URL);
    console.log("database: conectado");
  },
  async close() {
    // Na prática: await db.disconnect();
    console.log("database: desconectado");
  },
});

// close() é opcional: recursos que não precisam de limpeza não o declaram.
app.register({
  name: "cache",
  async init() {
    console.log("cache: iniciado");
  },
});

await app.start();
console.log("estado:", app.state);

await app.shutdown();
console.log("estado:", app.state);
