import type { LifeLineEvent, LifeLineLogger } from "./logger.js";

export interface PrettyLoggerOptions {
  /** Força cores no console (`true`) ou desativa (`false`). Padrão: cores quando há TTY e `NO_COLOR` não está definido. */
  readonly colors?: boolean;
  /** Recebe cada linha formatada, sem a quebra de linha. Padrão: `process.stdout`. */
  readonly write?: (line: string) => void;
}

// Formatador de console para os eventos do LifeLine. Cada linha começa com
// um timestamp relativo ao início da observação (`+0.35s`), alinhado por
// 4 espaços, seguido da mensagem colorida:
//
//   +0.35s    config no ar · 0.35s
//   +0.95s    redis falhou: ETIMEDOUT redis:6379
//   +1.45s    rollback: encerrando 2 em ordem inversa
export function prettyLogger(options: PrettyLoggerOptions = {}): LifeLineLogger {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const colors = options.colors ?? supportsColors();

  // Códigos ANSI. `paint` devolve a identidade quando as cores estão
  // desligadas, então o texto sai limpo em pipe, CI e com NO_COLOR.
  const paint =
    (code: string) =>
    (text: string): string =>
      colors ? `\u001b[${code}m${text}\u001b[0m` : text;
  const bold = paint("1");
  const dim = paint("2");
  const green = paint("32");
  const red = paint("31");
  const yellow = paint("33");

  const duration = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;
  const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  let referenceTime: number | null = null;

  const emit = (message: string): void => {
    const now = performance.now();
    referenceTime ??= now;
    const relative = ((now - referenceTime) / 1000).toFixed(2);
    write(`${dim(`+${relative}s`)}    ${message}`);
  };

  return (event: LifeLineEvent): void => {
    switch (event.type) {
      case "start":
        emit(bold("app.start()"));
        return;

      case "resource:starting": {
        const needs = event.dependsOn.length > 0 ? ` (precisa de ${event.dependsOn.join(", ")})` : "";
        emit(dim(`${event.name} iniciando${needs}`));
        return;
      }

      case "resource:ready":
        emit(green(`${event.name} no ar · ${duration(event.durationMs)}`));
        return;

      case "resource:failed":
        emit(red(`${event.name} falhou: ${messageOf(event.error)}`));
        return;

      case "resources:skipped":
        emit(yellow(`${event.names.join(", ")} ignorados: dependem de ${event.failedResource}`));
        return;

      case "resources:aborted":
        emit(yellow(`${event.names.join(", ")} ignorados: inicialização abortada`));
        return;

      case "rollback":
        emit(yellow(`rollback: encerrando ${event.count} em ordem inversa`));
        return;

      case "close:start":
        emit(yellow(`${event.name} encerrando`));
        return;

      case "close:end":
        if ("error" in event) {
          emit(red(`${event.name} não encerrou: ${messageOf(event.error)}`));
          return;
        }
        emit(yellow(`${event.name} encerrado · ${duration(event.durationMs)}`));
        return;

      case "start:resolved":
        emit(green(`app no ar · ${duration(event.durationMs)}`));
        return;

      case "start:rejected":
        emit(
          red(
            `LifelineStartError: ${event.failedResource} falhou · ` +
              `${event.closedCount} encerrados · ${event.leakedCount} vazaram`,
          ),
        );
        return;

      case "shutdown":
        emit(bold("app.shutdown()"));
        return;

      case "shutdown:resolved":
        emit(green(`app encerrado · ${duration(event.durationMs)}`));
        return;

      case "shutdown:rejected":
        emit(red(`ShutdownError: ${event.errorCount} recursos não fecharam`));
        return;
    }
  };
}

function supportsColors(): boolean {
  return process.env["NO_COLOR"] === undefined && process.stdout.isTTY === true;
}
