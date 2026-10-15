// Logs do ciclo de vida com prettyLogger: timestamps relativos, cores e o
// resumo da falha — tudo emitido pelo próprio gerenciador. Reproduz o
// cenário clássico: redis cai e a subida inteira é desfeita.
//
//   node examples/logging.js
import { LifeLine, prettyLogger } from "lifeline.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = new LifeLine({ logger: prettyLogger() });

app.register({
  name: "config",
  async init() {
    await sleep(350);
  },
  async close() {
    await sleep(150);
  },
});

app.register({
  name: "postgres",
  dependsOn: ["config"],
  async init() {
    await sleep(1100);
  },
  async close() {
    await sleep(650);
  },
});

app.register({
  name: "redis",
  dependsOn: ["config"],
  async init() {
    await sleep(600);
    // Este recurso falha ao iniciar — dispara o rollback dos anteriores.
    throw new Error("ETIMEDOUT redis:6379");
  },
});

app.register({
  name: "queue",
  dependsOn: ["redis"],
  async init() {
    console.log("queue: consumindo");
  },
});

app.register({
  name: "http",
  dependsOn: ["redis"],
  async init() {
    console.log("http: ouvindo");
  },
});

// Saída esperada (o init é sequencial: postgres sobe antes de redis):
//   app.start()
//   config iniciando
//   config no ar · 0.35s
//   postgres iniciando (precisa de config)
//   postgres no ar · 1.10s
//   redis iniciando (precisa de config)
//   redis falhou: ETIMEDOUT redis:6379
//   queue, http ignorados: dependem de redis
//   rollback: encerrando 2 em ordem inversa
//   postgres encerrando
//   postgres encerrado · 0.65s
//   config encerrando
//   config encerrado · 0.15s
//   LifelineStartError: redis falhou · 2 encerrados · 0 vazaram
//   start() rejeitou. O processo pode sair com código 1.
try {
  await app.start();
} catch {
  // O logger já mostrou o resumo; aqui a decisão é da aplicação.
  console.log("start() rejeitou. O processo pode sair com código 1.");
  process.exitCode = 1;
}
