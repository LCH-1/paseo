import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compilePlugin } from "./compiler.js";
import { pluginImportWorkerStats } from "./compiler-imports-pool.js";
import { createPluginBuildCache, type PluginBuildCacheOptions } from "./plugin-build-cache.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

// The cache declines builds whose inputs changed while they ran, judged by modification
// time. Fixtures are written moments before building, so date them back first.
async function settle(directory: string): Promise<void> {
  const past = new Date(Date.now() - 60 * 60 * 1000);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await settle(entryPath);
    await utimes(entryPath, past, past);
  }
  await utimes(directory, past, past);
}

async function createPlugin(): Promise<{ directory: string; client: string; server: string }> {
  const directory = await temporaryDirectory("paseo-plugin-build-cache-");
  await Promise.all(
    ["client", "server", "shared"].map((name) => mkdir(path.join(directory, name))),
  );
  const client = path.join(directory, "index.client.ts");
  const server = path.join(directory, "index.server.ts");
  await Promise.all([
    writeFile(path.join(directory, "shared", "labels.ts"), 'export const label = "first label";'),
    writeFile(
      path.join(directory, "shared", "shape.ts"),
      "export interface Shape { name: string }",
    ),
    writeFile(path.join(directory, "client", "surface.ts"), "export const surface = 1;"),
    writeFile(path.join(directory, "server", "value.js"), 'export const value = "from js";'),
    writeFile(
      client,
      `import { label } from "./shared/labels";
export default function contribute() { return () => label; }`,
    ),
    writeFile(
      server,
      `import type { Shape } from "./shared/shape";
import { label } from "./shared/labels";
import { value } from "./server/value";
export default function contribute() { const shape: Shape = { name: label }; return () => [shape, value]; }`,
    ),
  ]);
  await settle(directory);
  return { directory, client, server };
}

async function createCache(overrides: Partial<PluginBuildCacheOptions> = {}) {
  const directory = overrides.directory ?? (await temporaryDirectory("paseo-plugin-builds-"));
  const errors: unknown[] = [];
  const cache = createPluginBuildCache({
    directory,
    daemonVersion: "1.0.0",
    onError: (_operation, error) => errors.push(error),
    ...overrides,
  });
  return { cache, directory, errors };
}

function boundaryChecks(): number {
  const stats = pluginImportWorkerStats();
  return stats.workerReaders + stats.inThreadReaders;
}

async function entries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith(".build")).sort();
}

describe("plugin build cache", () => {
  it("reuses a bundle without re-running the boundary check while inputs are unchanged", async () => {
    const plugin = await createPlugin();
    const { cache, directory, errors } = await createCache();
    const uncached = await compilePlugin(plugin);

    const first = await compilePlugin(plugin, { cache });
    expect(await entries(directory)).toHaveLength(2);
    const checks = boundaryChecks();
    const second = await compilePlugin(plugin, { cache });

    expect(boundaryChecks()).toBe(checks);
    expect(first).toEqual(uncached);
    expect(second).toEqual(uncached);
    expect(errors).toEqual([]);
  });

  it("rebuilds when a bundled file changes", async () => {
    const plugin = await createPlugin();
    const { cache } = await createCache();
    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain("first label");

    await writeFile(
      path.join(plugin.directory, "shared", "labels.ts"),
      'export const label = "second label";',
    );
    const checks = boundaryChecks();
    const rebuilt = await compilePlugin(plugin, { cache });

    expect(boundaryChecks()).toBeGreaterThan(checks);
    expect(rebuilt.serverBundle).toContain("second label");
    expect(rebuilt.clientBundle).toContain("second label");
  });

  it("rebuilds when a new file changes how an unchanged import resolves", async () => {
    const plugin = await createPlugin();
    const { cache } = await createCache();
    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain("from js");

    await writeFile(
      path.join(plugin.directory, "server", "value.ts"),
      'export const value = "from ts";',
    );

    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain("from ts");
  });

  it("rebuilds when the plugin tsconfig appears or changes", async () => {
    const plugin = await createPlugin();
    await writeFile(
      path.join(plugin.directory, "shared", "other.ts"),
      'export const label = "alias";',
    );
    await writeFile(
      plugin.server,
      'import { label } from "@labels/current"; export default () => () => label;',
    );
    const config = (target: string) =>
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@labels/current": [target] } } });
    await writeFile(path.join(plugin.directory, "tsconfig.json"), config("shared/labels.ts"));
    await settle(plugin.directory);
    const { cache } = await createCache();
    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain("first label");

    await writeFile(path.join(plugin.directory, "tsconfig.json"), config("shared/other.ts"));

    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain('"alias"');
  });

  it("rebuilds when a dependency's package.json points at another entry", async () => {
    const plugin = await createPlugin();
    const dependency = path.join(plugin.directory, "node_modules", "fixture-dependency");
    await mkdir(dependency, { recursive: true });
    const manifest = (main: string) => JSON.stringify({ name: "fixture-dependency", main });
    await writeFile(path.join(dependency, "package.json"), manifest("first.js"));
    await writeFile(path.join(dependency, "first.js"), 'exports.marker = "first entry";');
    await writeFile(path.join(dependency, "second.js"), 'exports.marker = "second entry";');
    await writeFile(
      plugin.server,
      'import { marker } from "fixture-dependency"; export default () => () => marker;',
    );
    await settle(plugin.directory);
    const { cache } = await createCache();
    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain("first entry");

    await writeFile(path.join(dependency, "package.json"), manifest("second.js"));

    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain("second entry");
  });

  it("re-runs the boundary check when a file reached only through a type import changes", async () => {
    const plugin = await createPlugin();
    const { cache } = await createCache();
    await compilePlugin(plugin, { cache });

    // esbuild erases this edge, so the file is not in its metafile; the cache must still
    // notice it or a cached bundle would skip the check that rejects the new import.
    await writeFile(
      path.join(plugin.directory, "shared", "shape.ts"),
      'import type { PluginClientContext } from "@getpaseo/plugin/client"; export interface Shape { name: string; client?: PluginClientContext }',
    );

    await expect(compilePlugin(plugin, { cache })).rejects.toThrow("plugin shared");
  });

  it("rebuilds from a damaged entry and replaces it", async () => {
    const plugin = await createPlugin();
    const { cache, directory } = await createCache();
    const expected = await compilePlugin(plugin, { cache });
    for (const name of await entries(directory)) {
      const file = path.join(directory, name);
      const content = await readFile(file);
      content[content.length - 2] ^= 0xff;
      await writeFile(file, content);
    }
    const checks = boundaryChecks();

    expect(await compilePlugin(plugin, { cache })).toEqual(expected);
    expect(boundaryChecks()).toBeGreaterThan(checks);
    const repairedChecks = boundaryChecks();
    expect(await compilePlugin(plugin, { cache })).toEqual(expected);
    expect(boundaryChecks()).toBe(repairedChecks);

    for (const name of await entries(directory)) {
      await writeFile(path.join(directory, name), "not a cache entry");
    }
    expect(await compilePlugin(plugin, { cache })).toEqual(expected);
  });

  it("does not reuse a bundle built for another daemon version", async () => {
    const plugin = await createPlugin();
    const first = await createCache();
    await compilePlugin(plugin, { cache: first.cache });
    const other = await createCache({ directory: first.directory, daemonVersion: "1.0.1" });
    const checks = boundaryChecks();

    await compilePlugin(plugin, { cache: other.cache });

    expect(boundaryChecks()).toBeGreaterThan(checks);
    expect(await entries(first.directory)).toHaveLength(4);
  });

  it("does not keep a build whose inputs changed while it ran", async () => {
    const plugin = await createPlugin();
    const future = new Date(Date.now() + 60_000);
    await utimes(path.join(plugin.directory, "shared", "labels.ts"), future, future);
    const { cache, directory } = await createCache();

    await compilePlugin(plugin, { cache });

    expect(await entries(directory)).toEqual([]);
  });

  it("drops entries past the size cap or age, oldest first, and stale temporary files", async () => {
    const plugin = await createPlugin();
    const directory = await temporaryDirectory("paseo-plugin-builds-");
    let now = Date.now();
    const probe = await createCache({ directory, now: () => now });
    await compilePlugin({ client: null, server: plugin.server }, { cache: probe.cache });
    const [first] = await entries(directory);
    const size = (await stat(path.join(directory, first!))).size;
    const old = new Date(now - 2 * 60 * 60 * 1000);
    await utimes(path.join(directory, first!), old, old);
    await writeFile(path.join(directory, "abandoned.tmp"), "partial");
    await utimes(path.join(directory, "abandoned.tmp"), old, old);
    await writeFile(path.join(directory, "recent.tmp"), "partial");

    now += 2 * 60 * 1000;
    const capped = await createCache({ directory, now: () => now, maxBytes: size * 1.5 });
    await compilePlugin({ client: plugin.client, server: null }, { cache: capped.cache });

    const remaining = await readdir(directory);
    expect(remaining).not.toContain(first);
    expect(remaining).not.toContain("abandoned.tmp");
    expect(remaining).toContain("recent.tmp");
    expect(remaining.filter((name) => name.endsWith(".build"))).toHaveLength(1);

    now += 30 * 24 * 60 * 60 * 1000;
    const aged = await createCache({ directory, now: () => now, maxAgeMs: 24 * 60 * 60 * 1000 });
    await compilePlugin({ client: null, server: plugin.server }, { cache: aged.cache });
    expect(await entries(directory)).toHaveLength(1);
  });
});
