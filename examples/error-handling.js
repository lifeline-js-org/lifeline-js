// Tratamento de erros: rollback em falha de init() e diagnóstico das
// falhas de limpeza.
//
//   node examples/error-handling.js
import { LifeLine } from "lifeline.js";

const app = new LifeLine();

app.register({
  name: "database",
  async init() {
    console.log("database: conectado");
  },
  async close() {
    // Simula uma falha real de limpeza (conexão travada, timeout...).
    throw new Error("database: timeout ao desconectar");
  },
});

app.register({
  name: "server",
  async init() {
    console.log("server: iniciado");
  },
  async close() {
    console.log("server: parado");
  },
});

app.register({
  name: "queue",
  async init() {
    // Este recurso falha ao iniciar — dispara o rollback dos anteriores.
    throw new Error("queue: não conseguiu conectar ao broker");
  },
});

try {
  await app.start();
  console.log("estado:", app.state);
} catch (error) {
  if (error instanceof AggregateError) {
    // Causa raiz: o erro original do init() que falhou.
    console.error("falha na inicialização:", error.cause.message);

    // Cada falha de close(), identificada por recurso, com o erro real em cause.
    for (const cleanupError of error.errors) {
      console.error(
        `falha de limpeza em "${cleanupError.resourceName}":`,
        cleanupError.cause.message,
      );
    }
  } else {
    // Sem falhas de limpeza, o erro original chega como está.
    console.error("falha na inicialização:", error.message);
  }

  console.error("estado:", app.state);
  process.exitCode = 1;
}

// Saída esperada:
//   database: conectado
//   server: iniciado
//   falha na inicialização: queue: não conseguiu conectar ao broker
//   falha de limpeza em "database": database: timeout ao desconectar
//   estado: failed
