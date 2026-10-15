// Eventos estruturados do ciclo de vida. O gerenciador emite eventos de
// forma síncrona, no ponto exato de cada transição; a formatação (cores,
// timestamps, idioma) é responsabilidade do logger consumidor — o
// `prettyLogger` exportado é um formatador de console pronto para uso.
export type LifeLineEvent =
  /** start() validou o grafo e a operação de subida começou. */
  | { readonly type: "start" }
  /** Um init() está prestes a ser chamado. */
  | {
      readonly type: "resource:starting";
      readonly name: string;
      readonly dependsOn: readonly string[];
    }
  /** O init() do recurso concluiu. */
  | { readonly type: "resource:ready"; readonly name: string; readonly durationMs: number }
  /** O init() do recurso rejeitou; esse recurso não recebe close(). */
  | {
      readonly type: "resource:failed";
      readonly name: string;
      readonly durationMs: number;
      readonly error: unknown;
    }
  /** Recursos que dependem (direta ou transitive) do recurso que falhou. */
  | {
      readonly type: "resources:skipped";
      readonly names: readonly string[];
      readonly failedResource: string;
    }
  /** Recursos independentes que a inicialização abortada não chegou a tentar. */
  | { readonly type: "resources:aborted"; readonly names: readonly string[] }
  /** O rollback começou; `count` recursos serão fechados em ordem inversa. */
  | { readonly type: "rollback"; readonly count: number }
  /** Um close() está prestes a ser chamado. */
  | {
      readonly type: "close:start";
      readonly name: string;
      readonly reason: "rollback" | "shutdown";
    }
  /** Um close() terminou; `error` presente quando o close() rejeitou. */
  | {
      readonly type: "close:end";
      readonly name: string;
      readonly durationMs: number;
      readonly error?: unknown;
    }
  /** Todos os recursos subiram; o estado é `running`. */
  | { readonly type: "start:resolved"; readonly durationMs: number }
  /**
   * A subida falhou e o rollback terminou. `error` é o valor com que o
   * start() rejeitou (erro original ou AggregateError) — o contrato de
   * erros não muda; este evento é um resumo para observabilidade.
   */
  | {
      readonly type: "start:rejected";
      readonly failedResource: string;
      readonly closedCount: number;
      readonly leakedCount: number;
      readonly error: unknown;
    }
  /** shutdown() começou a encerrar recursos. */
  | { readonly type: "shutdown" }
  /** Todos os recursos fecharam; o estado é `stopped`. */
  | { readonly type: "shutdown:resolved"; readonly durationMs: number }
  /** O encerramento terminou com falhas de limpeza (AggregateError). */
  | {
      readonly type: "shutdown:rejected";
      readonly errorCount: number;
      readonly error: unknown;
    };

// Logger é apenas um consumidor de eventos: recebe cada transição de forma
// síncrona e decide o que fazer (imprimir, enviar para um serviço, etc).
// Deve ser rápido e não deve lançar — uma exceção aqui interrompe o ciclo
// de vida.
export interface LifeLineLogger {
  (event: LifeLineEvent): void;
}
