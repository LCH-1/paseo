import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compilePlugin } from "./compiler.js";
import { configurePluginImportWorkers, pluginImportWorkerStats } from "./compiler-imports-pool.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  configurePluginImportWorkers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

async function createPlugin(serverSource: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-import-pool-"));
  temporaryDirectories.push(directory);
  await Promise.all(
    ["client", "server", "shared"].map((name) => mkdir(path.join(directory, name))),
  );
  const client = path.join(directory, "index.client.ts");
  const server = path.join(directory, "index.server.ts");
  await Promise.all([
    writeFile(
      path.join(directory, "shared", "types.ts"),
      "export interface Labelled { label: string }",
    ),
    writeFile(path.join(directory, "client", "surface.ts"), "export const surface = 1;"),
    writeFile(
      client,
      'import type { Labelled } from "./shared/types"; export default () => () => ({ label: "client" }) satisfies Labelled;',
    ),
    writeFile(server, serverSource),
  ]);
  return { client, server };
}

const VALID_SERVER =
  'import type { Labelled } from "./shared/types"; export default () => () => ({ label: "server" }) satisfies Labelled;';
// Only the TypeScript pass sees this: esbuild erases type-only imports.
const TYPE_ONLY_VIOLATION =
  'import type { surface } from "./client/surface"; export default () => () => undefined as unknown as typeof surface;';

describe("plugin import workers", () => {
  it("parses plugin sources off the calling thread with the same result", async () => {
    const plugin = await createPlugin(VALID_SERVER);
    configurePluginImportWorkers({ size: 0 });
    const inThread = await compilePlugin(plugin);
    configurePluginImportWorkers();
    const before = pluginImportWorkerStats();

    const inWorker = await compilePlugin(plugin);

    const after = pluginImportWorkerStats();
    expect(after.workerReaders - before.workerReaders).toBe(2);
    expect(after.inThreadReaders).toBe(before.inThreadReaders);
    expect(inWorker).toEqual(inThread);
    await expect.poll(() => pluginImportWorkerStats().openWorkerReaders).toBe(0);
  });

  it("reports boundary violations found in a worker like the calling thread does", async () => {
    const plugin = await createPlugin(TYPE_ONLY_VIOLATION);
    configurePluginImportWorkers({ size: 0 });
    const inThread = await compilePlugin(plugin).catch((error: Error) => error.message);
    configurePluginImportWorkers();

    const inWorker = await compilePlugin(plugin).catch((error: Error) => error.message);

    expect(inThread).toContain("client-only module cannot be imported into the plugin server");
    expect(inWorker).toBe(inThread);
  });

  it("falls back to the calling thread when a worker cannot start", async () => {
    const valid = await createPlugin(VALID_SERVER);
    const violating = await createPlugin(TYPE_ONLY_VIOLATION);
    configurePluginImportWorkers({ size: 0 });
    const expected = await compilePlugin(valid);
    configurePluginImportWorkers({
      workerUrl: pathToFileURL(path.join(tmpdir(), "missing-paseo-import-worker.js")),
    });
    const before = pluginImportWorkerStats();

    expect(await compilePlugin(valid)).toEqual(expected);
    await expect(compilePlugin(violating)).rejects.toThrow("client-only module");

    await expect
      .poll(() => pluginImportWorkerStats().inThreadReaders - before.inThreadReaders)
      .toBe(4);
    expect(pluginImportWorkerStats().workerReaders).toBe(before.workerReaders);
  });

  it("lets an idle worker exit and starts another for the next build", async () => {
    const plugin = await createPlugin(VALID_SERVER);
    configurePluginImportWorkers({ size: 1, idleMs: 10 });
    await compilePlugin({ client: null, server: plugin.server });
    const started = pluginImportWorkerStats().workersStarted;
    await new Promise((resolve) => setTimeout(resolve, 200));

    await compilePlugin({ client: null, server: plugin.server });

    expect(pluginImportWorkerStats().workersStarted).toBe(started + 1);
  });
});
