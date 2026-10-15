// Aplicação real com LifeLine.js — o mesmo boot do simulador do site:
//
//   config → postgres ─┐
//           → redis → queue ─┴→ http
//
// O servidor HTTP é de verdade (node:http). Postgres, redis e queue são
// simulados com latência de rede — troque o corpo de init()/close() pelos
// clientes reais (pg, ioredis, amqplib) que a estrutura não muda.
//
//   npm run build                                  # garante o dist
//   node examples/real-app/app.mjs                 # boot completo
//   FAIL_AT=queue node examples/real-app/app.mjs   # quebra o boot na queue
//   FAIL_AT=postgres node examples/real-app/app.mjs
//   PORT=4000 node examples/real-app/app.mjs
//
// Com a aplicação no ar:
//   curl http://localhost:3000/          # rota de exemplo
//   curl http://localhost:3000/health    # estado + recursos vivos
//   Ctrl+C (SIGINT) ou kill -TERM        # encerramento gracioso

import { createServer } from "node:http";
import { LifeLine, prettyLogger } from "lifeline.js";

const PORT = Number(process.env.PORT ?? 3000);
const FAIL_AT = process.env.FAIL_AT ?? "none"; // none | config | postgres | redis | queue | http

const latency = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Simula a falha escolhida — o mesmo painel "escolha onde o boot vai
// falhar" do site. Em produção isso é o erro real do cliente externo.
function maybeFail(name, code = "ECONNREFUSED") {
  if (FAIL_AT !== name) return;
  throw Object.assign(new Error(`${name}: conexão recusada (${code})`), { code });
}

let config = null;
let db = null;
let redis = null;
let queue = null;
let server = null;

const app = new LifeLine({ logger: prettyLogger() });

app.register({
  name: "config",
  async init() {
    // Na prática: config = await loadConfig() — aqui lê o ambiente real.
    config = {
      port: PORT,
      databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/app",
      redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    };
    await latency(120);
    maybeFail("config", "ENOENT");
  },
});

app.register({
  name: "postgres",
  dependsOn: ["config"],
  async init() {
    await latency(240); // latência de rede simulada
    maybeFail("postgres");
    db = {
      // Na prática: db = await pg.Pool.connect(config.databaseUrl)
      connectedAt: new Date().toISOString(),
      async end() {
        await latency(150);
        db = null;
      },
    };
  },
  async close() {
    // Na prática: await db.end() — devolve as conexões do pool.
    await db.end();
  },
});

app.register({
  name: "redis",
  dependsOn: ["config"],
  async init() {
    await latency(180);
    maybeFail("redis", "ETIMEDOUT");
    // Na prática: redis = await new Redis(config.redisUrl).connect()
    redis = { async quit() { await latency(80); redis = null; } };
  },
  async close() {
    await redis.quit();
  },
});

app.register({
  name: "queue",
  dependsOn: ["redis"],
  async init() {
    await latency(200);
    maybeFail("queue");
    // Na prática: queue = await amqplib.connect(...) + canal + fila
    queue = { async stop() { await latency(100); queue = null; } };
  },
  async close() {
    await queue.stop();
  },
});

app.register({
  name: "http",
  dependsOn: ["postgres", "queue"],
  async init() {
    maybeFail("http");
    // Servidor HTTP real, dependendo do banco e da fila já estarem no ar.
    server = createServer((request, response) => {
      console.log(`   ↳ ${request.method} ${request.url}`);
      const body = JSON.stringify({
        ok: true,
        route: request.url,
        state: app.state,
        uptimeSec: Number(process.uptime().toFixed(1)),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
    // Na prática: await listen(db, queue, config.port)
    await new Promise((resolve) => server.listen(config.port, resolve));
  },
  async close() {
    // Drena conexões abertas antes de resolver — o close() é aguardado.
    await new Promise((resolve) => server.close(resolve));
    server = null;
  },
});

// ---------------------------------------------------------------------------
// Boot + sinais. shutdown() durante starting lança, então o handler sempre
// aguarda o boot terminar (sucesso ou rollback) antes de encerrar — o
// padrão recomendado no README.

const settled = app.start().then(
  () => ({ ok: true }),
  (error) => ({ ok: false, error }),
);

function reportStartupError(error) {
  if (error instanceof AggregateError) {
    console.error("causa raiz:", error.cause?.message ?? error.cause);
    for (const cleanupError of error.errors) {
      console.error(`falha ao fechar "${cleanupError.resourceName}":`, cleanupError.cause?.message);
    }
    return;
  }
  console.error("falha na inicialização:", error?.message ?? error);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.log(`\n${signal} recebido · aguardando o boot para encerrar...`);
    void (async () => {
      await settled; // boot concluído ou rollback já executado
      if (app.state === "failed") {
        process.exit(1);
      }
      try {
        await app.shutdown();
        console.log(`estado final: ${app.state}`);
        process.exit(0);
      } catch (error) {
        reportStartupError(error);
        process.exit(1);
      }
    })();
  });
}

console.log(`▶ boot · PORT=${PORT} · FAIL_AT=${FAIL_AT}`);

const result = await settled;
if (!result.ok) {
  reportStartupError(result.error);
  console.error("estado:", app.state);
  process.exit(1);
}

console.log(`\n✔ aplicação no ar → http://localhost:${PORT} (estado: ${app.state})`);
console.log("  rotas: GET / · GET /health");
console.log("  encerre com Ctrl+C (SIGINT) ou kill -TERM\n");
