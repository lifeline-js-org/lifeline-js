// Encerramento gracioso com um servidor HTTP real: sobe o servidor via
// Lifeline e o derruba em ordem inversa ao receber SIGINT/SIGTERM.
//
//   node examples/graceful-shutdown.js
//   curl http://localhost:3000/
//   Ctrl+C  (ou kill -TERM <pid>)
import { createServer } from "node:http";
import { LifeLine } from "lifeline.js";

const PORT = Number(process.env.PORT ?? 3000);
const app = new LifeLine();

// Um servidor HTTP de verdade: o listen() é o init(), o close() é o close().
const server = createServer((request, response) => {
  response.end("lifeline: ok\n");
});

app.register({
  name: "http-server",
  init() {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, () => {
        console.log(`http-server: ouvindo em http://localhost:${PORT}`);
        resolve();
      });
    });
  },
  close() {
    // Aguarda as conexões abertas terminarem antes de fechar.
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n${signal} recebido: encerrando...`);
    app.shutdown().then(
      () => {
        console.log("encerrado com sucesso");
        process.exit(0);
      },
      (error) => {
        // AggregateError quando algum close() falhou.
        console.error("falha ao encerrar:", error);
        process.exit(1);
      },
    );
  });
}

await app.start();
console.log("Ctrl+C para encerrar");
