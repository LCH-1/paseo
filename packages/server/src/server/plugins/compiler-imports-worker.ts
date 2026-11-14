import { parentPort } from "node:worker_threads";
import {
  createPluginImportReader,
  type PluginImportKind,
  type PluginImportReader,
} from "./compiler-imports.js";

// Runs the TypeScript half of the plugin boundary check (parsing whole bundles and
// declaration-aware resolution) so a cache miss does not stall the daemon's event loop.
export type ImportWorkerRequest =
  | { id: number; op: "open"; reader: number; directory: string }
  | { id: number; op: "read"; reader: number; file: string }
  | {
      id: number;
      op: "resolve";
      reader: number;
      specifier: string;
      importer: string;
      kind: PluginImportKind;
    }
  | { id: number; op: "close"; reader: number };

export type ImportWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string };

const readers = new Map<number, PluginImportReader>();

function requireReader(id: number): PluginImportReader {
  const reader = readers.get(id);
  if (!reader) throw new Error(`Plugin import reader ${id} is not open`);
  return reader;
}

function handle(request: ImportWorkerRequest): unknown {
  switch (request.op) {
    case "open": {
      const reader = createPluginImportReader(request.directory);
      readers.set(request.reader, reader);
      return reader.configFiles;
    }
    case "read":
      return requireReader(request.reader).read(request.file);
    case "resolve":
      return requireReader(request.reader).resolve(
        request.specifier,
        request.importer,
        request.kind,
      );
    case "close":
      readers.delete(request.reader);
      return null;
  }
}

parentPort?.on("message", (request: ImportWorkerRequest) => {
  let response: ImportWorkerResponse;
  try {
    response = { id: request.id, ok: true, value: handle(request) };
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port, not window.postMessage
  parentPort?.postMessage(response);
});
