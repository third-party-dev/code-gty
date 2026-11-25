// The WebAssembly JS API as Node provides it. @types/node 20 does not declare
// it and the host build has no DOM lib; the webview gets it from lib.dom.

type BufferSource = ArrayBufferView | ArrayBuffer;

declare namespace WebAssembly {
  type ImportValue = ExportValue | number;
  type ExportValue = ((...args: never[]) => unknown) | Global | Memory | Table;
  type ModuleImports = Record<string, ImportValue>;
  type Imports = Record<string, ModuleImports>;
  type Exports = Record<string, ExportValue>;

  interface ModuleImportDescriptor {
    kind: 'function' | 'global' | 'memory' | 'table' | 'tag';
    module: string;
    name: string;
  }
  interface ModuleExportDescriptor {
    kind: 'function' | 'global' | 'memory' | 'table' | 'tag';
    name: string;
  }

  class Module {
    constructor(bytes: BufferSource);
    static imports(module: Module): ModuleImportDescriptor[];
    static exports(module: Module): ModuleExportDescriptor[];
  }
  class Instance {
    constructor(module: Module, imports?: Imports);
    readonly exports: Exports;
  }
  class Memory {
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }
  class Table {
    readonly length: number;
    get(index: number): unknown;
    set(index: number, value: unknown): void;
    grow(delta: number, value?: unknown): number;
  }
  class Global {
    value: unknown;
  }
  interface WebAssemblyInstantiatedSource {
    module: Module;
    instance: Instance;
  }
  function compile(bytes: BufferSource): Promise<Module>;
  function instantiate(module: Module, imports?: Imports): Promise<Instance>;
  function instantiate(bytes: BufferSource, imports?: Imports): Promise<WebAssemblyInstantiatedSource>;
}
