import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// A plugin bundle is a pure function of the files esbuild and the boundary check read,
// how those files resolve, and the compiler that read them. Each cached bundle keeps the
// inputs its last build recorded (esbuild's metafile plus the files the boundary check
// parsed) with their content hashes, the directory listings around them, and the
// package.json / tsconfig.json / node_modules state of every ancestor directory. A
// lookup recomputes those digests without bundling; any difference, an unreadable or
// damaged entry, or a different compiler, daemon, esbuild, TypeScript, or Node version
// falls back to a full build, which also re-runs the boundary check.

const FORMAT = "paseo-plugin-build-cache/1";
/** Bump when what a cached boundary check accepts changes without a compiler source change. */
export const PLUGIN_BOUNDARY_RULES_VERSION = 1;
const COMPILER_MODULES = [
  "compiler",
  "compiler-imports",
  "compiler-imports-pool",
  "compiler-imports-worker",
  "plugin-sdk-specifiers",
  "plugin-build-cache",
] as const;
const PROBED_CONFIG_FILES = ["package.json", "tsconfig.json", "jsconfig.json"] as const;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const TEMPORARY_FILE_AGE_MS = 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;
// Coarse file systems round modification times down by up to two seconds.
const MODIFICATION_SLACK_MS = 2_000;
const HASH_SLICE_BYTES = 1024 * 1024;

const nodeRequire = createRequire(import.meta.url);

export interface PluginBuildKeyInput {
  target: "client" | "server";
  entryPath: string;
  pluginDirectory: string;
  esbuildVersion: string;
  options: unknown;
}

export interface PluginBuildRecorder {
  /**
   * Keeps `bundle` with `files`, every file the build or its boundary check read,
   * and `probes`, files it looked for that may be missing (absolute paths). Resolves
   * false without storing when an input is gone or changed while building, or when
   * the entry cannot be written.
   */
  store(bundle: string, files: Iterable<string>, probes?: Iterable<string>): Promise<boolean>;
}

export interface PluginBuildCache {
  key(input: PluginBuildKeyInput): Promise<string | null>;
  lookup(key: string): Promise<string | null>;
  /** Call right before building `key`; the recorder stores what that build produced. */
  begin(key: string, pluginDirectory: string): Promise<PluginBuildRecorder>;
}

export interface PluginBuildCacheOptions {
  directory: string;
  daemonVersion: string;
  maxBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
  onError?: (operation: "key" | "store" | "prune", error: unknown) => void;
}

type DependencyKind = "file" | "dir" | "modules";
type Dependency = [kind: DependencyKind, path: string, digest: string | null];

interface CacheHeader {
  format: typeof FORMAT;
  key: string;
  bundleBytes: number;
  bundleHash: string;
  dependencies: Dependency[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Hash in slices so a multi-megabyte bundle never holds the event loop for long.
async function hashBuffer(buffer: Buffer): Promise<string> {
  const hash = createHash("sha256");
  for (let offset = 0; offset < buffer.length; offset += HASH_SLICE_BYTES) {
    hash.update(buffer.subarray(offset, offset + HASH_SLICE_BYTES));
    if (offset + HASH_SLICE_BYTES < buffer.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return hash.digest("hex");
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function fileDigest(file: string): Promise<string | null> {
  try {
    const [content, canonical] = await Promise.all([readFile(file), realpath(file)]);
    return `${await hashBuffer(content)}:${canonical}`;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function entryType(entry: Dirent): string {
  if (entry.isDirectory()) return "d";
  if (entry.isSymbolicLink()) return "l";
  return entry.isFile() ? "f" : "o";
}

function listingLine(entry: Dirent): string {
  return `${entry.name}\u0000${entryType(entry)}`;
}

async function listing(directory: string): Promise<string[] | null> {
  try {
    return (await readdir(directory, { withFileTypes: true })).map(listingLine).sort();
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function directoryDigest(directory: string): Promise<string | null> {
  const lines = await listing(directory);
  return lines ? sha256(lines.join("\n")) : null;
}

// Bare imports resolve through every ancestor node_modules, scoped packages one level down.
async function modulesDigest(directory: string): Promise<string | null> {
  const lines = await listing(directory);
  if (!lines) return null;
  const scoped = await Promise.all(
    lines
      .filter((line) => line.startsWith("@") && !line.endsWith("\u0000f"))
      .map(async (line) => {
        const scope = line.slice(0, line.indexOf("\u0000"));
        return (await listing(path.join(directory, scope)))?.map((child) => `${scope}/${child}`);
      }),
  );
  return sha256(
    [...lines, ...scoped.flatMap((children) => children ?? ["<unreadable>"])].join("\n"),
  );
}

function digest(kind: DependencyKind, target: string): Promise<string | null> {
  if (kind === "file") return fileDigest(target);
  if (kind === "dir") return directoryDigest(target);
  return modulesDigest(target);
}

function ancestorsOf(directory: string): string[] {
  const ancestors: string[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    ancestors.push(current);
    if (path.dirname(current) === current) return ancestors;
  }
}

function ancestorProbes(
  directories: Iterable<string>,
  inputs: ReadonlySet<string> = new Set(),
): Dependency[] {
  const ancestors = new Set([...directories].flatMap((directory) => ancestorsOf(directory)));
  const probes: Dependency[] = [];
  for (const ancestor of [...ancestors].sort()) {
    for (const name of PROBED_CONFIG_FILES) {
      const probe = path.join(ancestor, name);
      if (!inputs.has(probe)) probes.push(["file", probe, null]);
    }
    probes.push(["modules", path.join(ancestor, "node_modules"), null]);
  }
  return probes;
}

function describeDependencies(
  inputs: ReadonlySet<string>,
  probes: ReadonlySet<string>,
): Dependency[] {
  const directories = [...new Set([...inputs].map((file) => path.dirname(file)))].sort();
  return [
    ...[...inputs].sort().map((file): Dependency => ["file", file, null]),
    ...[...probes]
      .filter((file) => !inputs.has(file))
      .sort()
      .map((file): Dependency => ["file", file, null]),
    ...directories.map((directory): Dependency => ["dir", directory, null]),
    ...ancestorProbes(directories, new Set([...inputs, ...probes])),
  ];
}

const dependencyId = ([kind, target]: Dependency) => `${kind}\u0000${target}`;

async function digests(dependencies: readonly Dependency[]): Promise<Array<string | null>> {
  return Promise.all(dependencies.map(([kind, target]) => digest(kind, target)));
}

async function compilerFingerprint(): Promise<string> {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const hash = createHash("sha256");
  for (const name of COMPILER_MODULES) {
    hash.update(`${name}\u0000`);
    hash.update(await readFile(new URL(`./${name}${extension}`, import.meta.url)));
  }
  const typescriptManifest = nodeRequire.resolve("typescript/package.json");
  const typescript = JSON.parse(await readFile(typescriptManifest, "utf8")) as {
    version?: unknown;
  };
  hash.update(`typescript\u0000${String(typescript.version)}`);
  return hash.digest("hex");
}

export function createPluginBuildCache(options: PluginBuildCacheOptions): PluginBuildCache {
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const entryPath = (key: string) => path.join(options.directory, `${key}.build`);
  let fingerprint: Promise<string | null> | null = null;
  let lastPrune = Number.NEGATIVE_INFINITY;

  function report(operation: "key" | "store" | "prune", error: unknown): void {
    options.onError?.(operation, error);
  }

  async function prune(): Promise<void> {
    const startedAt = now();
    if (startedAt - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = startedAt;
    const entries: Array<{ file: string; size: number; modified: number }> = [];
    for (const name of await readdir(options.directory)) {
      const file = path.join(options.directory, name);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) continue;
      if (name.endsWith(".tmp")) {
        if (startedAt - info.mtimeMs > TEMPORARY_FILE_AGE_MS) await rm(file, { force: true });
      } else if (name.endsWith(".build")) {
        entries.push({ file, size: info.size, modified: info.mtimeMs });
      }
    }
    entries.sort((left, right) => right.modified - left.modified);
    let kept = 0;
    for (const entry of entries) {
      kept += entry.size;
      if (startedAt - entry.modified > maxAgeMs || kept > maxBytes) {
        await rm(entry.file, { force: true });
      }
    }
  }

  async function store(
    key: string,
    bundle: string,
    files: Iterable<string>,
    probes: Iterable<string>,
    startedAt: number,
    before: ReadonlyMap<string, string | null>,
  ): Promise<boolean> {
    let temporary: string | null = null;
    try {
      const inputs = new Set([...files].map((file) => path.resolve(file)));
      const probed = new Set([...probes].map((file) => path.resolve(file)));
      const dependencies = describeDependencies(inputs, probed);
      const current = await digests(dependencies);
      const changed = await Promise.all(
        dependencies.map(async (dependency, index) => {
          const [kind, target] = dependency;
          const value = current[index];
          const earlier = before.get(dependencyId(dependency));
          if (earlier !== undefined && earlier !== value) return true;
          if (value === null) return kind === "file" && inputs.has(target);
          // A file edited after esbuild read it would be recorded with content the
          // bundle does not contain; anything modified since the build began is suspect.
          const info = await stat(target);
          return info.mtimeMs >= startedAt - MODIFICATION_SLACK_MS;
        }),
      );
      if (changed.includes(true)) return false;
      const body = Buffer.from(bundle, "utf8");
      const header: CacheHeader = {
        format: FORMAT,
        key,
        bundleBytes: body.length,
        bundleHash: await hashBuffer(body),
        dependencies: dependencies.map(([kind, target], index) => [kind, target, current[index]!]),
      };
      await mkdir(options.directory, { recursive: true });
      temporary = path.join(
        options.directory,
        `${key}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
      );
      await writeFile(temporary, Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), body]));
      await rename(temporary, entryPath(key));
      temporary = null;
      // Entries age by the cache's clock, which lookups also use to mark them used.
      const written = new Date(now());
      await utimes(entryPath(key), written, written).catch(() => undefined);
    } catch (error) {
      report("store", error);
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      return false;
    }
    await prune().catch((error) => report("prune", error));
    return true;
  }

  return {
    async key(input) {
      fingerprint ??= compilerFingerprint().catch((error) => {
        report("key", error);
        return null;
      });
      const compiler = await fingerprint;
      if (!compiler) return null;
      return sha256(
        JSON.stringify({
          format: FORMAT,
          rules: PLUGIN_BOUNDARY_RULES_VERSION,
          compiler,
          daemon: options.daemonVersion,
          esbuild: input.esbuildVersion,
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
          // esbuild names inputs relative to the working directory in bundle comments.
          cwd: process.cwd(),
          target: input.target,
          entryPath: input.entryPath,
          pluginDirectory: input.pluginDirectory,
          options: input.options,
        }),
      );
    },

    async lookup(key) {
      try {
        const file = entryPath(key);
        const content = await readFile(file);
        const newline = content.indexOf(10);
        if (newline < 0) return null;
        const header = JSON.parse(content.toString("utf8", 0, newline)) as CacheHeader;
        if (header.format !== FORMAT || header.key !== key) return null;
        const body = content.subarray(newline + 1);
        if (body.length !== header.bundleBytes || !Array.isArray(header.dependencies)) return null;
        if ((await hashBuffer(body)) !== header.bundleHash) return null;
        const current = await Promise.all(
          header.dependencies.map(([kind, target]) => digest(kind, target)),
        );
        if (current.some((value, index) => value !== header.dependencies[index]?.[2])) return null;
        const touched = new Date(now());
        await utimes(file, touched, touched).catch(() => undefined);
        return body.toString("utf8");
      } catch {
        return null;
      }
    },

    async begin(key, pluginDirectory) {
      const startedAt = now();
      // Paths that may be missing can only show a change against an earlier look: a
      // config deleted mid-build would otherwise be recorded as never there.
      const ancestors = ancestorProbes([pluginDirectory]);
      const before = new Map<string, string | null>();
      const values = await digests(ancestors).catch(() => null);
      ancestors.forEach((probe, index) => {
        if (values) before.set(dependencyId(probe), values[index] ?? null);
      });
      return {
        store: (bundle, files, probes = []) => store(key, bundle, files, probes, startedAt, before),
      };
    },
  };
}
