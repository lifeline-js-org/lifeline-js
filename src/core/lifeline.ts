import type { Resource } from "./resource.js";
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

export class LifeLine {
  private readonly resources = new Map<string, RegisteredResource>();
  private readonly initialized: RegisteredResource[] = [];
  private currentState: LifeLineState = "created";
  private startup: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;

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
    try {
      for (const entry of order) {
        await entry.resource.init();
        // Só entra na lista quem concluiu o init(). Um recurso que falha
        // durante a própria inicialização é responsável por limpar seus
        // efeitos parciais; o gerenciador não chama close() nele.
        this.initialized.push(entry);
      }
    } catch (error) {
      const cleanupErrors = await this.closeInReverse(this.initialized);
      this.initialized.length = 0;
      this.currentState = "failed";

      if (cleanupErrors.length === 0) {
        throw error;
      }
      throw new AggregateError(
        cleanupErrors,
        "A inicialização falhou e houve erros durante a limpeza",
        { cause: error },
      );
    }

    this.currentState = "running";
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
    const entries = [...this.initialized];
    this.initialized.length = 0;

    const cleanupErrors = await this.closeInReverse(entries);
    this.currentState = "stopped";

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Houve erros durante o encerramento");
    }
  }

  private async closeInReverse(entries: readonly RegisteredResource[]): Promise<CleanupError[]> {
    const cleanupErrors: CleanupError[] = [];

    for (const entry of [...entries].reverse()) {
      if (entry.resource.close === undefined) {
        continue;
      }

      try {
        await entry.resource.close();
      } catch (error) {
        cleanupErrors.push(new CleanupError(entry.name, { cause: error }));
      }
    }

    return cleanupErrors;
  }
}
