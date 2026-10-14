export interface Resource {
  readonly name: string;
  readonly dependsOn?: readonly string[];
  init(): void | Promise<void>;
  close?(): void | Promise<void>;
}
