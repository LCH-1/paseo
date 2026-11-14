import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compilePlugin } from "./compiler.js";
import { pluginImportWorkerStats } from "./compiler-imports-pool.js";
import {
  createPluginBuildCache,
  pluginCompilerFingerprint,
  type PluginBuildCacheOptions,
  type PluginBuildKeyInput,
  type PluginCompilerSources,
} from "./plugin-build-cache.js";

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

async function createPlugin(
  layout: "alone" | "inside node_modules" = "alone",
): Promise<{ directory: string; client: string; server: string }> {
  const root = await temporaryDirectory("paseo-plugin-build-cache-");
  const directory = layout === "alone" ? root : path.join(root, "node_modules", "fixture-plugin");
  await mkdir(directory, { recursive: true });
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
  await settle(root);
  return { directory, client, server };
}

// Junctions need no symlink privilege on Windows; elsewhere this is a directory symlink.
async function link(target: string, linkPath: string): Promise<void> {
  await rm(linkPath, { force: true });
  await symlink(target, linkPath, "junction");
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

type Plugin = Awaited<ReturnType<typeof createPlugin>>;
type Cache = Awaited<ReturnType<typeof createCache>>["cache"];

/** Compiles from the cache, failing unless the bundles come back without a boundary check. */
async function reused(plugin: Plugin, cache: Cache) {
  const checks = boundaryChecks();
  const result = await compilePlugin(plugin, { cache });
  expect(boundaryChecks()).toBe(checks);
  return result;
}

// esbuild takes useDefineForClassFields from the tsconfig that applies to each file; false
// assigns class fields in the constructor, which the bundle shows as `this.label`.
const CLASS_FIELD_SOURCE =
  'class Box { label = "boxed"; } export const box = () => new Box().label;';
const ASSIGNED_FIELD = "this.label";
const classFields = (define: boolean) =>
  JSON.stringify({ compilerOptions: { useDefineForClassFields: define } });

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
    await writeFile(plugin.server, `${CLASS_FIELD_SOURCE} export default () => box;`);
    await settle(plugin.directory);
    const { cache } = await createCache();
    expect((await compilePlugin(plugin, { cache })).serverBundle).not.toContain(ASSIGNED_FIELD);
    expect((await reused(plugin, cache)).serverBundle).not.toContain(ASSIGNED_FIELD);

    const tsconfig = path.join(plugin.directory, "tsconfig.json");
    await writeFile(tsconfig, classFields(false));
    await settle(plugin.directory);
    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain(ASSIGNED_FIELD);
    expect((await reused(plugin, cache)).serverBundle).toContain(ASSIGNED_FIELD);

    await writeFile(tsconfig, classFields(true));

    expect((await compilePlugin(plugin, { cache })).serverBundle).not.toContain(ASSIGNED_FIELD);
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

  it("rebuilds when a linked dependency is pointed at another copy", async () => {
    const plugin = await createPlugin();
    const store = await temporaryDirectory("paseo-plugin-build-cache-deps-");
    for (const version of ["v1", "v2"]) {
      const copy = path.join(store, `dep-${version}`);
      await mkdir(copy);
      await writeFile(
        path.join(copy, "package.json"),
        JSON.stringify({ name: "dep", main: "index.js" }),
      );
      await writeFile(path.join(copy, "index.js"), `exports.marker = "dep ${version}";`);
    }
    await mkdir(path.join(plugin.directory, "node_modules"));
    const linked = path.join(plugin.directory, "node_modules", "dep");
    await link(path.join(store, "dep-v1"), linked);
    await writeFile(
      plugin.server,
      'import { marker } from "dep"; export default () => () => marker;',
    );
    await settle(plugin.directory);
    await settle(store);
    const { cache } = await createCache();
    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain("dep v1");

    // The first copy stays as it was, so only the link itself tells the builds apart.
    await link(path.join(store, "dep-v2"), linked);

    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain("dep v2");
  });

  it("rebuilds when a linked plugin directory is pointed at another copy", async () => {
    const plugin = await createPlugin();
    for (const version of ["v1", "v2"]) {
      const copy = path.join(plugin.directory, "server", `lib-${version}`);
      await mkdir(copy);
      await writeFile(path.join(copy, "value.ts"), `export const value = "lib ${version}";`);
    }
    const linked = path.join(plugin.directory, "server", "lib");
    await link(path.join(plugin.directory, "server", "lib-v1"), linked);
    await writeFile(
      plugin.server,
      'import { value } from "./server/lib/value"; export default () => () => value;',
    );
    await settle(plugin.directory);
    const { cache } = await createCache();
    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain("lib v1");

    await link(path.join(plugin.directory, "server", "lib-v2"), linked);

    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain("lib v2");
  });

  it("rebuilds when a config extended by the plugin tsconfig changes", async () => {
    const plugin = await createPlugin();
    await writeFile(plugin.server, `${CLASS_FIELD_SOURCE} export default () => box;`);
    await writeFile(path.join(plugin.directory, "base.json"), classFields(false));
    await writeFile(
      path.join(plugin.directory, "tsconfig.json"),
      [
        "{",
        "  // comments and trailing commas are allowed here",
        '  "extends": "./base",',
        "}",
      ].join("\n"),
    );
    await settle(plugin.directory);
    const { cache } = await createCache();
    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain(ASSIGNED_FIELD);
    expect((await reused(plugin, cache)).serverBundle).toContain(ASSIGNED_FIELD);

    await writeFile(path.join(plugin.directory, "base.json"), classFields(true));

    expect((await compilePlugin(plugin, { cache })).serverBundle).not.toContain(ASSIGNED_FIELD);
  });

  it("rebuilds when a config extended by a nested tsconfig changes", async () => {
    const plugin = await createPlugin();
    // esbuild reads the tsconfig nearest to each file; only server/ has one here.
    await writeFile(path.join(plugin.directory, "server", "main.ts"), CLASS_FIELD_SOURCE);
    await writeFile(
      plugin.server,
      'import { box } from "./server/main"; export default () => box;',
    );
    await mkdir(path.join(plugin.directory, "configs"));
    await writeFile(path.join(plugin.directory, "configs", "base.json"), classFields(false));
    await writeFile(
      path.join(plugin.directory, "server", "tsconfig.json"),
      JSON.stringify({ extends: ["../configs/base.json"] }),
    );
    await settle(plugin.directory);
    const { cache } = await createCache();
    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain(ASSIGNED_FIELD);
    expect((await reused(plugin, cache)).serverBundle).toContain(ASSIGNED_FIELD);

    await writeFile(path.join(plugin.directory, "configs", "base.json"), classFields(true));

    expect((await compilePlugin(plugin, { cache })).serverBundle).not.toContain(ASSIGNED_FIELD);
  });

  it("rebuilds when a config a nested tsconfig extends from a package changes", async () => {
    const plugin = await createPlugin();
    await writeFile(path.join(plugin.directory, "server", "main.ts"), CLASS_FIELD_SOURCE);
    await writeFile(
      plugin.server,
      'import { box } from "./server/main"; export default () => box;',
    );
    const configPackage = path.join(plugin.directory, "node_modules", "fixture-tsconfig");
    await mkdir(configPackage, { recursive: true });
    await writeFile(
      path.join(configPackage, "package.json"),
      JSON.stringify({ name: "fixture-tsconfig" }),
    );
    await writeFile(path.join(configPackage, "base.json"), classFields(false));
    await writeFile(
      path.join(plugin.directory, "server", "tsconfig.json"),
      JSON.stringify({ extends: "fixture-tsconfig/base.json" }),
    );
    await settle(plugin.directory);
    const { cache } = await createCache();
    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain(ASSIGNED_FIELD);
    expect((await reused(plugin, cache)).serverBundle).toContain(ASSIGNED_FIELD);

    await writeFile(path.join(configPackage, "base.json"), classFields(true));

    expect((await compilePlugin(plugin, { cache })).serverBundle).not.toContain(ASSIGNED_FIELD);
  });

  // Only esbuild reads a nested tsconfig; the boundary check's TypeScript reads the plugin's.
  it.each(["the plugin tsconfig", "a config a nested tsconfig extends"] as const)(
    "rebuilds when a new file matches an earlier paths substitution in %s",
    async (where) => {
      const plugin = await createPlugin();
      // shared/a exists, so only its listing, which no input lies in, can show foo.ts appear.
      await mkdir(path.join(plugin.directory, "shared", "a"));
      await mkdir(path.join(plugin.directory, "shared", "b"));
      await writeFile(path.join(plugin.directory, "shared", "a", "other.ts"), "export {};");
      await writeFile(
        path.join(plugin.directory, "shared", "b", "foo.ts"),
        'export const origin = "from-b";',
      );
      const paths = (prefix: string) =>
        JSON.stringify({
          compilerOptions: { paths: { "@x/*": [`${prefix}shared/a/*`, `${prefix}shared/b/*`] } },
        });
      if (where === "the plugin tsconfig") {
        await writeFile(
          plugin.server,
          'import { origin } from "@x/foo"; export default () => () => origin;',
        );
        await writeFile(path.join(plugin.directory, "tsconfig.json"), paths("./"));
      } else {
        await writeFile(
          path.join(plugin.directory, "server", "main.ts"),
          'export { origin } from "@x/foo";',
        );
        await writeFile(
          plugin.server,
          'import { origin } from "./server/main"; export default () => () => origin;',
        );
        // Paths without a baseUrl are relative to the config that sets them.
        await mkdir(path.join(plugin.directory, "configs"));
        await writeFile(path.join(plugin.directory, "configs", "paths.json"), paths("../"));
        await writeFile(
          path.join(plugin.directory, "server", "tsconfig.json"),
          JSON.stringify({ extends: "../configs/paths.json" }),
        );
      }
      await settle(plugin.directory);
      const { cache } = await createCache();
      expect((await compilePlugin(plugin, { cache })).serverBundle).toContain("from-b");

      await writeFile(
        path.join(plugin.directory, "shared", "a", "foo.ts"),
        'export const origin = "from-a";',
      );
      const uncached = await compilePlugin(plugin);

      expect(uncached.serverBundle).toContain("from-a");
      expect(await compilePlugin(plugin, { cache })).toEqual(uncached);
    },
  );

  it("rebuilds when a new file under the tsconfig baseUrl shadows a package", async () => {
    const plugin = await createPlugin();
    const vendor = path.join(plugin.directory, "server", "vendor");
    await mkdir(vendor);
    await writeFile(path.join(vendor, "other.ts"), "export {};");
    const dependency = path.join(plugin.directory, "node_modules", "thing");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({ name: "thing", main: "index.js" }),
    );
    await writeFile(path.join(dependency, "index.js"), 'exports.origin = "from-node-modules";');
    await writeFile(
      plugin.server,
      'import { origin } from "thing"; export default () => () => origin;',
    );
    // Inherited from an extended config, relative to that config.
    await mkdir(path.join(plugin.directory, "configs"));
    await writeFile(
      path.join(plugin.directory, "configs", "base.json"),
      JSON.stringify({ compilerOptions: { baseUrl: "../server/vendor" } }),
    );
    await writeFile(
      path.join(plugin.directory, "tsconfig.json"),
      JSON.stringify({ extends: "./configs/base.json" }),
    );
    await settle(plugin.directory);
    const { cache } = await createCache();
    expect((await compilePlugin(plugin, { cache })).serverBundle).toContain("from-node-modules");

    await writeFile(path.join(vendor, "thing.ts"), 'export const origin = "from-vendor";');
    const uncached = await compilePlugin(plugin);

    expect(uncached.serverBundle).toContain("from-vendor");
    expect(await compilePlugin(plugin, { cache })).toEqual(uncached);
  });

  // esbuild ignores a tsconfig inside node_modules; the boundary check's TypeScript does not.
  it.each(["alone", "inside node_modules"] as const)(
    "re-runs the boundary check when a declaration appears under an earlier tsconfig typeRoots entry (plugin %s)",
    async (layout) => {
      const plugin = await createPlugin(layout);
      const typeRoot = path.join(plugin.directory, "server", "types");
      await mkdir(path.join(typeRoot, "unrelated"), { recursive: true });
      await writeFile(path.join(typeRoot, "unrelated", "index.d.ts"), "export {};");
      const installed = path.join(plugin.directory, "node_modules", "@types", "thing");
      await mkdir(installed, { recursive: true });
      await writeFile(path.join(installed, "index.d.ts"), "declare const thing: string;");
      await writeFile(
        plugin.server,
        ['/// <reference types="thing" />', "export default () => () => 1;"].join("\n"),
      );
      await writeFile(
        path.join(plugin.directory, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { typeRoots: ["./server/types", "./node_modules/@types"] },
        }),
      );
      await settle(plugin.directory);
      const { cache } = await createCache();
      await compilePlugin(plugin, { cache });

      await mkdir(path.join(typeRoot, "thing"));
      await writeFile(
        path.join(typeRoot, "thing", "index.d.ts"),
        'import type { PluginClientContext } from "@getpaseo/plugin/client"; export type Thing = PluginClientContext;',
      );

      await expect(compilePlugin(plugin)).rejects.toThrow("plugin server");
      await expect(compilePlugin(plugin, { cache })).rejects.toThrow("plugin server");
    },
  );

  it("re-runs the boundary check when a declaration appears in an earlier tsconfig rootDirs entry", async () => {
    const plugin = await createPlugin();
    for (const name of ["first", "second"]) {
      await mkdir(path.join(plugin.directory, "shared", name));
    }
    await writeFile(path.join(plugin.directory, "shared", "first", "other.d.ts"), "export {};");
    await writeFile(
      path.join(plugin.directory, "shared", "second", "shape.d.ts"),
      "export type Shape = string;",
    );
    await writeFile(
      plugin.server,
      'import type { Shape } from "./shared/shape"; export default () => (shape: Shape) => shape;',
    );
    await rm(path.join(plugin.directory, "shared", "shape.ts"));
    await writeFile(
      path.join(plugin.directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { rootDirs: ["shared", "shared/first", "shared/second"] },
      }),
    );
    await settle(plugin.directory);
    const { cache } = await createCache();
    await compilePlugin(plugin, { cache });

    await writeFile(
      path.join(plugin.directory, "shared", "first", "shape.d.ts"),
      'import type { PluginClientContext } from "@getpaseo/plugin/client"; export type Shape = PluginClientContext;',
    );

    await expect(compilePlugin(plugin)).rejects.toThrow("plugin shared");
    await expect(compilePlugin(plugin, { cache })).rejects.toThrow("plugin shared");
  });

  it("keeps reusing a bundle whose dependency ships a tsconfig with paths, which esbuild ignores", async () => {
    const plugin = await createPlugin();
    const modules = path.join(plugin.directory, "node_modules");
    await mkdir(path.join(modules, "dep"), { recursive: true });
    await mkdir(path.join(modules, "other"));
    await writeFile(
      path.join(modules, "dep", "package.json"),
      JSON.stringify({ name: "dep", main: "index.js" }),
    );
    await writeFile(path.join(modules, "dep", "index.js"), 'module.exports = require("other");');
    await writeFile(path.join(modules, "dep", "shadow.js"), 'exports.origin = "from-shadow";');
    await writeFile(
      path.join(modules, "dep", "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { other: ["./shadow.js"] } } }),
    );
    await writeFile(
      path.join(modules, "other", "package.json"),
      JSON.stringify({ name: "other", main: "index.js" }),
    );
    await writeFile(path.join(modules, "other", "index.js"), 'exports.origin = "from-other";');
    await writeFile(
      plugin.server,
      'import { origin } from "dep"; export default () => () => origin;',
    );
    await settle(plugin.directory);
    const { cache } = await createCache();

    const built = await compilePlugin(plugin, { cache });

    expect(built.serverBundle).toContain("from-other");
    expect(built.serverBundle).not.toContain("from-shadow");
    expect(await reused(plugin, cache)).toEqual(built);
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

  it("keys a build by the compiler, daemon, esbuild version, and what it builds", async () => {
    const input: PluginBuildKeyInput = {
      target: "server",
      entryPath: path.join(tmpdir(), "plugin", "index.server.ts"),
      pluginDirectory: path.join(tmpdir(), "plugin"),
      esbuildVersion: "0.25.12",
      options: { bundle: true, platform: "node" },
    };
    async function keyWith(
      options: Partial<PluginBuildCacheOptions>,
      change: Partial<PluginBuildKeyInput> = {},
    ): Promise<string | null> {
      const { cache } = await createCache({
        compilerFingerprint: async () => "compiler a",
        ...options,
      });
      return cache.key({ ...input, ...change });
    }
    const key = await keyWith({});

    const others = [
      await keyWith({ compilerFingerprint: async () => "compiler b" }),
      await keyWith({ daemonVersion: "1.0.1" }),
      await keyWith({}, { esbuildVersion: "0.25.13" }),
      await keyWith({}, { options: { bundle: true, platform: "neutral" } }),
      await keyWith({}, { target: "client" }),
      await keyWith({}, { entryPath: path.join(tmpdir(), "plugin", "index.client.ts") }),
      await keyWith({}, { pluginDirectory: path.join(tmpdir(), "other-plugin") }),
    ];

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await keyWith({})).toBe(key);
    expect(new Set([key, ...others]).size).toBe(others.length + 1);
  });

  it("fingerprints the compiler by its boundary rules, every module's source, and TypeScript", async () => {
    const read: string[] = [];
    const sources = (overrides: Partial<PluginCompilerSources> = {}): PluginCompilerSources => ({
      boundaryRulesVersion: 1,
      async readModule(name) {
        read.push(name);
        return Buffer.from(`source of ${name}`);
      },
      typescriptVersion: async () => "5.9.3",
      ...overrides,
    });
    const fingerprint = await pluginCompilerFingerprint(sources());
    const modules = [...read];

    expect(modules).toEqual(
      expect.arrayContaining([
        "compiler",
        "compiler-imports",
        "compiler-imports-pool",
        "compiler-imports-worker",
        "plugin-sdk-specifiers",
        "plugin-build-cache",
      ]),
    );
    expect(await pluginCompilerFingerprint(sources())).toBe(fingerprint);
    const others = [
      await pluginCompilerFingerprint(sources({ boundaryRulesVersion: 2 })),
      await pluginCompilerFingerprint(sources({ typescriptVersion: async () => "5.9.4" })),
      ...(await Promise.all(
        modules.map((changed) =>
          pluginCompilerFingerprint(
            sources({
              readModule: async (name) =>
                // Same length, so only the content tells them apart.
                Buffer.from(name === changed ? `SOURCE OF ${name}` : `source of ${name}`),
            }),
          ),
        ),
      )),
    ];
    expect(new Set([fingerprint, ...others]).size).toBe(others.length + 1);
    // The installed compiler's modules are all where the fingerprint looks for them.
    await expect(pluginCompilerFingerprint()).resolves.toMatch(/^[0-9a-f]{64}$/);
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
