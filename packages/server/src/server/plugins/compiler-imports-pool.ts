import { Worker } from "node:worker_threads";
import {
  createPluginImportReader,
  type ModuleImport,
  type PluginImportKind,
  type PluginImportReader,
} from "./compiler-imports.js";
import type { ImportWorkerRequest, ImportWorkerResponse } from "./compiler-imports-worker.js";

// Parsing a pre-bundled 5 MB plugin with the TypeScript compiler takes 0.5-0.9 s. On the
// daemon's thread that stalls every client for the whole parse, so readers live in worker
// threads and the daemon only awaits their answers. A worker that cannot start or dies
// hands its readers back to an in-thread reader, which is how this ran before.

export interface AsyncPluginImportReader {
  readonly configFiles: readonly string[];
  read(file: string): Promise<ModuleImport[]>;
  resolve(specifier: string, importer: string, kind: PluginImportKind): Promise<string | undefined>;
  close(): void;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ImportWorkerCall = DistributiveOmit<ImportWorkerRequest, "id">;

class ImportWorkerUnavailableError extends Error {}

const DEFAULT_POOL_SIZE = 2;
const DEFAULT_IDLE_MS = 10_000;

function defaultWorkerUrl(): URL {
  return new URL(
    import.meta.url.endsWith(".ts")
      ? "./compiler-imports-worker.ts"
      : "./compiler-imports-worker.js",
    import.meta.url,
  );
}

// Same loader the plugin child process uses when the daemon runs from TypeScript sources.
function workerExecArgv(): string[] {
  if (!import.meta.url.endsWith(".ts")) return [];
  const loaderUrl = new URL("../../terminal/terminal-ts-loader.mjs", import.meta.url).href;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

class ImportWorker {
  openReaders = 0;
  answered = false;
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 0;
  private failure: Error | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    url: URL,
    private readonly idleMs: number,
    private readonly onGone: (worker: ImportWorker) => void,
  ) {
    this.worker = new Worker(url, { execArgv: workerExecArgv() });
    this.worker.unref();
    this.worker.on("message", (response: ImportWorkerResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (this.pending.size === 0) this.worker.unref();
      this.answered = true;
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new Error(response.message));
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => this.fail(new Error(`exited with code ${code}`)));
  }

  get alive(): boolean {
    return this.failure === null;
  }

  request(call: ImportWorkerCall): Promise<unknown> {
    if (this.failure) {
      return Promise.reject(new ImportWorkerUnavailableError(this.failure.message));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.pending.size === 1) this.worker.ref();
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads Worker, not window.postMessage
      this.worker.postMessage({ ...call, id } as ImportWorkerRequest);
    });
  }

  acquire(): void {
    this.openReaders += 1;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  release(): void {
    this.openReaders -= 1;
    if (this.openReaders > 0 || !this.alive) return;
    // TypeScript stays loaded only while plugins are being compiled.
    this.idleTimer = setTimeout(() => {
      if (this.openReaders === 0) this.retire();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  /** Leaves the pool at once, so no reader is handed to a worker that is exiting. */
  retire(): void {
    if (!this.alive) return;
    this.fail(new Error("retired"));
    void this.worker.terminate();
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.onGone(this);
    for (const pending of this.pending.values()) {
      pending.reject(new ImportWorkerUnavailableError(error.message));
    }
    this.pending.clear();
  }
}

function inThreadReader(reader: PluginImportReader): AsyncPluginImportReader {
  return {
    configFiles: reader.configFiles,
    read: async (file) => reader.read(file),
    resolve: async (specifier, importer, kind) => reader.resolve(specifier, importer, kind),
    close: () => undefined,
  };
}

class WorkerImportReader implements AsyncPluginImportReader {
  private local: PluginImportReader | null = null;
  private closed = false;

  constructor(
    private readonly worker: ImportWorker,
    private readonly id: number,
    private readonly directory: string,
    readonly configFiles: readonly string[],
  ) {}

  read(file: string): Promise<ModuleImport[]> {
    return this.call({ op: "read", reader: this.id, file }, (reader) =>
      reader.read(file),
    ) as Promise<ModuleImport[]>;
  }

  resolve(
    specifier: string,
    importer: string,
    kind: PluginImportKind,
  ): Promise<string | undefined> {
    return this.call({ op: "resolve", reader: this.id, specifier, importer, kind }, (reader) =>
      reader.resolve(specifier, importer, kind),
    ) as Promise<string | undefined>;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.worker.alive) {
      void this.worker.request({ op: "close", reader: this.id }).catch(() => undefined);
    }
    this.worker.release();
  }

  private async call(
    call: ImportWorkerCall,
    inThread: (reader: PluginImportReader) => unknown,
  ): Promise<unknown> {
    if (!this.local) {
      try {
        return await this.worker.request(call);
      } catch (error) {
        if (!(error instanceof ImportWorkerUnavailableError)) throw error;
        pool.stats.inThreadReaders += 1;
        this.local = createPluginImportReader(this.directory);
      }
    }
    return inThread(this.local);
  }
}

class ImportWorkerPool {
  readonly stats = { workerReaders: 0, inThreadReaders: 0, workersStarted: 0 };
  private readonly workers = new Set<ImportWorker>();
  private nextReader = 0;
  private unavailable = false;
  private size = DEFAULT_POOL_SIZE;
  private idleMs = DEFAULT_IDLE_MS;
  private url = defaultWorkerUrl();

  get openReaders(): number {
    let open = 0;
    for (const worker of this.workers) open += worker.openReaders;
    return open;
  }

  configure(options: { size?: number; idleMs?: number; workerUrl?: URL }): void {
    // Readers already open keep their worker; nothing new is assigned to these.
    for (const worker of this.workers) if (worker.openReaders === 0) worker.retire();
    this.workers.clear();
    this.size = options.size ?? DEFAULT_POOL_SIZE;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.url = options.workerUrl ?? defaultWorkerUrl();
    this.unavailable = false;
  }

  async open(directory: string): Promise<AsyncPluginImportReader> {
    const worker = this.pick();
    if (worker) {
      const id = ++this.nextReader;
      worker.acquire();
      try {
        const configFiles = (await worker.request({
          op: "open",
          reader: id,
          directory,
        })) as string[];
        this.stats.workerReaders += 1;
        return new WorkerImportReader(worker, id, directory, configFiles);
      } catch (error) {
        worker.release();
        if (!(error instanceof ImportWorkerUnavailableError)) throw error;
      }
    }
    this.stats.inThreadReaders += 1;
    return inThreadReader(createPluginImportReader(directory));
  }

  private pick(): ImportWorker | null {
    if (this.unavailable || this.size <= 0) return null;
    let best: ImportWorker | null = null;
    for (const worker of this.workers) {
      if (!best || worker.openReaders < best.openReaders) best = worker;
    }
    if (best && (best.openReaders === 0 || this.workers.size >= this.size)) return best;
    try {
      const worker = new ImportWorker(this.url, this.idleMs, (gone) => {
        this.workers.delete(gone);
        // A worker that never answered cannot load here (for example a missing
        // module); stop paying its startup on every build.
        if (!gone.answered && gone.openReaders > 0) this.unavailable = true;
      });
      this.workers.add(worker);
      this.stats.workersStarted += 1;
      return worker;
    } catch {
      this.unavailable = true;
      return best;
    }
  }
}

const pool = new ImportWorkerPool();

export function openPluginImportReader(directory: string): Promise<AsyncPluginImportReader> {
  return pool.open(directory);
}

/** Test seam: pool size 0 keeps every reader on the calling thread. */
export function configurePluginImportWorkers(
  options: { size?: number; idleMs?: number; workerUrl?: URL } = {},
): void {
  pool.configure(options);
}

export function pluginImportWorkerStats(): Readonly<
  ImportWorkerPool["stats"] & { openWorkerReaders: number }
> {
  return { ...pool.stats, openWorkerReaders: pool.openReaders };
}
