import type { Resource } from "./resource.js";
import type { LifeLineEvent, LifeLineLogger } from "./logger.js";
import { CleanupError } from "./errors.js";

export type LifeLineState = "created" | "starting" | "running" | "stopping" | "stopped" | "failed";

// Configuração capturada no register(): name e dependsOn são cópias,
// imunes a alterações posteriores no objeto original. A referência
// original é preservada para executar init() e close() com o `this`
// do usuário.
interface RegisteredResource {
  readonly name: string;
  readonly dependsOn: readonly string[];
  readonly resource: Resource;
}

export interface LifeLineOptions {
  /** Consumidor dos eventos do ciclo de vida. Padrão: nenhum (sem logs). */
  readonly logger?: LifeLineLogger;
}

export class LifeLine {
  private readonly resources = new Map<string, RegisteredResource>();
  private readonly initialized: RegisteredResource[] = [];
  private readonly logger: LifeLineLogger | undefined;
  private currentState: LifeLineState = "created";
  private startup: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: LifeLineOptions = {}) {
    this.logger = options.logger;
  }

  get state(): LifeLineState {
    return this.currentState;
  }

  register(resource: Resource): void {
    if (this.currentState !== "created") {
      throw new Error("Não é possível registrar recursos fora do estado inicial");
    }
    if (resource.name.trim() === "") {
      throw new Error("Nome de recurso inválido: o nome não pode ser vazio");
    }
    if (resource.name !== resource.name.trim()) {
      throw new Error(
        `Nome de recurso inválido: "${resource.name}" não pode começar nem terminar com espaço`,
      );
    }
    if (this.resources.has(resource.name)) {
      throw new Error(`Recurso duplicado: "${resource.name}" já foi registrado`);
    }

    this.resources.set(resource.name, {
      name: resource.name,
      dependsOn: [...(resource.dependsOn ?? [])],
      resource,
    });
  }

  start(): Promise<void> {
    // Encerrando ou já encerrado: estado terminal, nada é inicializado.
    if (this.currentState === "stopping" || this.currentState === "stopped") {
      throw new Error("Não é possível iniciar: o gerenciador já foi encerrado");
    }

    // Iniciando, em execução ou após falha: devolve a mesma operação.
    if (this.startup !== null) {
      return this.startup;
    }

    // Valida dependências e resolve a ordem antes de qualquer init().
    // Em erro síncrono o gerenciador permanece em "created" (não envenenado).
    const order = this.computeInitOrder();

    this.currentState = "starting";
    this.emit({ type: "start" });
    // Adia a execução para o próximo microtask: this.startup é atribuída
    // antes de qualquer init() rodar, então chamadas reentrantes (de dentro
    // de um init()) enxergam a Promise e compartilham a mesma operação.
    this.startup = Promise.resolve().then(() => this.initializeAll(order));
    return this.startup;
  }

  shutdown(): Promise<void> {
    // Encerrando ou já encerrado: compartilha a mesma operação.
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }
    if (this.currentState === "starting") {
      // Falha imediatamente: shutdown() durante a inicialização não agenda
      // o encerramento para depois — o chamador decide o que fazer.
      throw new Error(
        "Não é possível chamar shutdown() enquanto a inicialização está em andamento",
      );
    }

    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  // Limitação v1: DFS recursivo — cadeias muito longas de dependências
  // poderiam estourar a pilha de chamadas. Para grafos muito grandes,
  // seria necessária uma versão iterativa.
  private computeInitOrder(): RegisteredResource[] {
    const order: RegisteredResource[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    // DFS em ordem de registro: dependências antecedem o dependente.
    // Sem dependências, a ordem efetiva é a de registro.
    const visit = (entry: RegisteredResource, path: string[]): void => {
      if (visited.has(entry.name)) {
        return;
      }
      if (visiting.has(entry.name)) {
        const cycleStart = path.indexOf(entry.name);
        const cycle = [...path.slice(cycleStart), entry.name].join(" → ");
        throw new Error(`Ciclo de dependência detectado: ${cycle}`);
      }

      visiting.add(entry.name);
      const seenDependencies = new Set<string>();
      for (const dependencyName of entry.dependsOn) {
        if (seenDependencies.has(dependencyName)) {
          throw new Error(`Dependência duplicada em "${entry.name}": "${dependencyName}"`);
        }
        seenDependencies.add(dependencyName);

        const dependency = this.resources.get(dependencyName);
        if (dependency === undefined) {
          throw new Error(
            `Dependência inexistente: "${entry.name}" depende de "${dependencyName}", que não foi registrado`,
          );
        }
        visit(dependency, [...path, entry.name]);
      }
      visiting.delete(entry.name);

      visited.add(entry.name);
      order.push(entry);
    };

    for (const entry of this.resources.values()) {
      visit(entry, []);
    }

    return order;
  }

  private async initializeAll(order: RegisteredResource[]): Promise<void> {
    const startedAt = performance.now();

    for (let index = 0; index < order.length; index += 1) {
      const entry = order[index]!;
      this.emit({ type: "resource:starting", name: entry.name, dependsOn: entry.dependsOn });

      const attemptStartedAt = performance.now();
      try {
        await entry.resource.init();
      } catch (error) {
        this.emit({
          type: "resource:failed",
          name: entry.name,
          durationMs: performance.now() - attemptStartedAt,
          error,
        });
        return this.failStartup(order, index, error, startedAt);
      }

      this.emit({
        type: "resource:ready",
        name: entry.name,
        durationMs: performance.now() - attemptStartedAt,
      });
      // Só entra na lista quem concluiu o init(). Um recurso que falha
      // durante a própria inicialização é responsável por limpar seus
      // efeitos parciais; o gerenciador não chama close() nele.
      this.initialized.push(entry);
    }

    this.currentState = "running";
    this.emit({ type: "start:resolved", durationMs: performance.now() - startedAt });
  }

  // Rollback + diagnóstico da falha: relata o que foi pulado, fecha o que
  // já estava inicializado em ordem inversa e rejeita o start() seguindo o
  // contrato de erros — erro original com rollback limpo, AggregateError
  // quando houve falha de limpeza.
  private async failStartup(
    order: readonly RegisteredResource[],
    failedIndex: number,
    error: unknown,
    startedAt: number,
  ): Promise<never> {
    const failed = order[failedIndex]!;

    const dependents: string[] = [];
    const aborted: string[] = [];
    for (const entry of order.slice(failedIndex + 1)) {
      (this.dependsOnResource(entry, failed.name) ? dependents : aborted).push(entry.name);
    }
    if (dependents.length > 0) {
      this.emit({ type: "resources:skipped", names: dependents, failedResource: failed.name });
    }
    if (aborted.length > 0) {
      this.emit({ type: "resources:aborted", names: aborted });
    }

    const rollbackEntries = [...this.initialized];
    this.initialized.length = 0;
    if (rollbackEntries.length > 0) {
      this.emit({ type: "rollback", count: rollbackEntries.length });
    }

    const cleanupErrors = await this.closeInReverse(rollbackEntries, "rollback");
    this.currentState = "failed";

    // Recursos fechados com sucesso no rollback. Quem não tem close() não
    // vaza nada (não há o que fechar); quem falhou ao fechar vaza.
    const closedCount =
      rollbackEntries.filter((entry) => entry.resource.close !== undefined).length -
      cleanupErrors.length;

    const rejection =
      cleanupErrors.length === 0
        ? error
        : new AggregateError(
            cleanupErrors,
            "A inicialização falhou e houve erros durante a limpeza",
            { cause: error },
          );

    this.emit({
      type: "start:rejected",
      failedResource: failed.name,
      closedCount,
      leakedCount: cleanupErrors.length,
      error: rejection,
    });

    throw rejection;
  }

  private async performShutdown(): Promise<void> {
    // Política v1: o rollback é executado uma única vez, durante a falha
    // da inicialização. Mesmo que algum close() tenha falhado, shutdown()
    // não tenta de novo — não é um mecanismo de recuperação. Os erros de
    // limpeza permanecem acessíveis na Promise rejeitada do start().
    if (this.currentState === "failed") {
      return;
    }

    this.currentState = "stopping";
    this.emit({ type: "shutdown" });
    const startedAt = performance.now();
    const entries = [...this.initialized];
    this.initialized.length = 0;

    const cleanupErrors = await this.closeInReverse(entries, "shutdown");
    this.currentState = "stopped";

    if (cleanupErrors.length > 0) {
      const rejection = new AggregateError(cleanupErrors, "Houve erros durante o encerramento");
      this.emit({ type: "shutdown:rejected", errorCount: cleanupErrors.length, error: rejection });
      throw rejection;
    }

    this.emit({ type: "shutdown:resolved", durationMs: performance.now() - startedAt });
  }

  private async closeInReverse(
    entries: readonly RegisteredResource[],
    reason: "rollback" | "shutdown",
  ): Promise<CleanupError[]> {
    const cleanupErrors: CleanupError[] = [];

    for (const entry of [...entries].reverse()) {
      if (entry.resource.close === undefined) {
        continue;
      }

      this.emit({ type: "close:start", name: entry.name, reason });
      const closeStartedAt = performance.now();
      try {
        await entry.resource.close();
      } catch (error) {
        this.emit({
          type: "close:end",
          name: entry.name,
          durationMs: performance.now() - closeStartedAt,
          error,
        });
        cleanupErrors.push(new CleanupError(entry.name, { cause: error }));
        continue;
      }
      this.emit({
        type: "close:end",
        name: entry.name,
        durationMs: performance.now() - closeStartedAt,
      });
    }

    return cleanupErrors;
  }

  private emit(event: LifeLineEvent): void {
    this.logger?.(event);
  }

  // true quando `entry` alcança `target` pelo grafo de dependências. Só é
  // chamado depois que start() validou o grafo (dependências existentes,
  // sem ciclos), então a busca sempre termina.
  private dependsOnResource(
    entry: RegisteredResource,
    target: string,
    seen = new Set<string>(),
  ): boolean {
    for (const dependencyName of entry.dependsOn) {
      if (dependencyName === target) {
        return true;
      }
      if (seen.has(dependencyName)) {
        continue;
      }
      seen.add(dependencyName);

      const dependency = this.resources.get(dependencyName);
      if (dependency !== undefined && this.dependsOnResource(dependency, target, seen)) {
        return true;
      }
    }
    return false;
  }
}
