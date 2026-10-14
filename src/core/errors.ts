export class CleanupError extends Error {
  readonly resourceName: string;

  constructor(resourceName: string, options?: ErrorOptions) {
    super(`Falha ao fechar o recurso "${resourceName}"`, options);
    this.name = "CleanupError";
    this.resourceName = resourceName;
  }
}
