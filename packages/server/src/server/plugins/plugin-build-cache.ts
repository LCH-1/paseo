import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  readlink,
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
// parsed) with their content hashes, the directory listings around them (including the
// directories relative imports went through, and where every link points), the
// package.json / tsconfig.json / node_modules state of every ancestor directory, and
// every config those tsconfig files extend. A lookup recomputes those digests without
// bundling; any difference, an unreadable or damaged entry, or a different compiler,
// daemon, esbuild, TypeScript, or Node version falls back to a full build, which also
// re-runs the boundary check. A build is not kept when a config that applies to it sends
// imports through directories nothing else records (see REDIRECTING_OPTIONS), nor, by the
// compiler, when it bundles a glob that a template or concatenated import makes.

const FORMAT = "paseo-plugin-build-cache/2";
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
const TS_CONFIG_FILES: ReadonlySet<string> = new Set(["tsconfig.json", "jsconfig.json"]);
// These make esbuild or the boundary check's TypeScript try other directories before the
// file an import ended up at (`paths` substitutions in order, `baseUrl` before node_modules,
// other `rootDirs`, earlier `typeRoots`). Those directories hold no input, so a file
// added there would go unseen; builds under such a config are not kept.
const REDIRECTING_OPTIONS = ["baseUrl", "paths", "rootDirs", "typeRoots"] as const;
const MAX_EXTENDS_DEPTH = 32;
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
   * `probes`, files it looked for that may be missing, and `directories`, where
   * relative imports were looked up before links were followed (absolute paths).
   * Resolves false without storing when an input is gone or changed while building,
   * when a config's `extends` cannot be followed, when a config that applies sets one
   * of {@link REDIRECTING_OPTIONS}, or when the entry cannot be written.
   */
  store(
    bundle: string,
    files: Iterable<string>,
    probes?: Iterable<string>,
    directories?: Iterable<string>,
  ): Promise<boolean>;
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
  /** Defaults to {@link pluginCompilerFingerprint} of the installed compiler. */
  compilerFingerprint?: () => Promise<string>;
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

// A link pointed at another copy keeps its name, and the old copy may stay as it was,
// so a link is listed with where it points.
async function listingLine(directory: string, entry: Dirent): Promise<string> {
  const line = `${entry.name}\u0000${entryType(entry)}`;
  if (!entry.isSymbolicLink()) return line;
  return `${line}\u0000${await readlink(path.join(directory, entry.name))}`;
}

async function listing(directory: string): Promise<string[] | null> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map((entry) => listingLine(directory, entry)))).sort();
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** A listing headed by where the directory really is, which any link on its path decides. */
async function canonicalListing(directory: string): Promise<string[] | null> {
  const lines = await listing(directory);
  if (!lines) return null;
  try {
    return [await realpath(directory), ...lines];
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function directoryDigest(directory: string): Promise<string | null> {
  const lines = await canonicalListing(directory);
  return lines ? sha256(lines.join("\n")) : null;
}

// Bare imports resolve through every ancestor node_modules, scoped packages one level down.
async function modulesDigest(directory: string): Promise<string | null> {
  const lines = await canonicalListing(directory);
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
  lookups: ReadonlySet<string>,
): Dependency[] {
  const directories = [...new Set([...inputs].map((file) => path.dirname(file)))].sort();
  const listed = new Set(directories);
  return [
    ...[...inputs].sort().map((file): Dependency => ["file", file, null]),
    ...[...probes]
      .filter((file) => !inputs.has(file))
      .sort()
      .map((file): Dependency => ["file", file, null]),
    ...directories.map((directory): Dependency => ["dir", directory, null]),
    ...[...lookups]
      .filter((directory) => !listed.has(directory))
      .sort()
      .map((directory): Dependency => ["dir", directory, null]),
    ...ancestorProbes(directories, new Set([...inputs, ...probes])),
  ];
}

/** The end of the JSON string that starts at `start`. */
function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
  return index + 1;
}

/** Reads a tsconfig, which may hold comments and trailing commas outside its strings. */
function parseConfig(text: string): unknown {
  let output = "";
  const trailingComma = /(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*[}\]]/y;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; ) {
    if (text[index] === '"') {
      const end = stringEnd(text, index);
      output += text.slice(index, end);
      index = end;
    } else if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
    } else if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
    } else {
      trailingComma.lastIndex = index + 1;
      if (text[index] !== "," || !trailingComma.test(text)) output += text[index];
      index += 1;
    }
  }
  return JSON.parse(output);
}

/** Undefined when the file is missing; throws when it cannot be read or parsed. */
async function readConfig(file: string): Promise<unknown> {
  try {
    return parseConfig(await readFile(file, "utf8"));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null))?.isFile() ?? false;
}

function packageName(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
}

/** Every target in a package's `exports`, or null when one is a pattern. */
function exportTargets(exports: unknown): string[] | null {
  if (typeof exports === "string") return exports.includes("*") ? null : [exports];
  if (!exports || typeof exports !== "object") return [];
  const targets: string[] = [];
  for (const value of Object.values(exports)) {
    const nested = exportTargets(value);
    if (!nested) return null;
    targets.push(...nested);
  }
  return targets;
}

function configCandidates(target: string): string[] {
  return [target, `${target}.json`, path.join(target, "tsconfig.json")];
}

/**
 * Every file an `extends` may name, as esbuild and TypeScript look: a path tries the
 * file and the file plus .json; a package tries each ancestor node_modules, with the
 * package.json `tsconfig` field and `exports` targets. Null when that cannot be told.
 */
async function extendsCandidates(value: string, directory: string): Promise<string[] | null> {
  if (value.startsWith(".") || path.isAbsolute(value)) {
    const target = path.resolve(directory, value);
    return [target, `${target}.json`];
  }
  const candidates: string[] = [];
  for (const ancestor of ancestorsOf(directory)) {
    if (path.basename(ancestor) === "node_modules") continue;
    const modules = path.join(ancestor, "node_modules");
    const packageDirectory = path.join(modules, packageName(value));
    const manifestPath = path.join(packageDirectory, "package.json");
    candidates.push(manifestPath, ...configCandidates(path.join(modules, value)));
    const manifest = await readConfig(manifestPath).catch(() => null);
    if (!manifest || typeof manifest !== "object") continue;
    const { tsconfig, exports } = manifest as { tsconfig?: unknown; exports?: unknown };
    if (typeof tsconfig === "string") {
      candidates.push(...configCandidates(path.resolve(packageDirectory, tsconfig)));
    }
    const targets = exportTargets(exports);
    if (!targets) return null;
    for (const target of targets) {
      candidates.push(...configCandidates(path.resolve(packageDirectory, target)));
    }
  }
  return candidates;
}

function insideNodeModules(file: string): boolean {
  return path.dirname(file).split(path.sep).includes("node_modules");
}

function redirectsImports(config: unknown): boolean {
  const options = (config as { compilerOptions?: unknown } | null | undefined)?.compilerOptions;
  if (!options || typeof options !== "object") return false;
  return REDIRECTING_OPTIONS.some((name) => (options as Record<string, unknown>)[name] != null);
}

interface ConfigRoot {
  file: string;
  /** Whether esbuild or the boundary check may resolve imports by this config. */
  applies: boolean;
}

/**
 * esbuild applies the tsconfig.json or jsconfig.json nearest each file it bundles, except
 * one inside node_modules, and every config that one extends; the boundary check's
 * TypeScript applies the configs it read. Follows `extends` from `roots`, returning each
 * candidate looked for and following every one that exists, so no config esbuild may
 * have read is left out. Null when a config cannot be read or followed here, or when one
 * that may apply sets one of {@link REDIRECTING_OPTIONS}.
 */
async function extendedConfigs(roots: Iterable<ConfigRoot>): Promise<string[] | null> {
  const candidates = new Set<string>();
  const seen = new Set<string>();
  const pending = [...roots].map(({ file, applies }) => ({ file, applies, depth: 0 }));
  while (pending.length > 0) {
    const { file, applies, depth } = pending.pop()!;
    const id = `${applies}\u0000${file}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let config: unknown;
    try {
      config = await readConfig(file);
    } catch {
      return null;
    }
    if (applies && redirectsImports(config)) return null;
    const value = (config as { extends?: unknown } | null | undefined)?.extends;
    if (value === undefined) continue;
    const values: unknown[] = Array.isArray(value) ? value : [value];
    if (depth >= MAX_EXTENDS_DEPTH || values.some((entry) => typeof entry !== "string")) {
      return null;
    }
    for (const entry of values as string[]) {
      const found = await extendsCandidates(entry, path.dirname(file));
      if (!found) return null;
      for (const candidate of found) {
        candidates.add(candidate);
        if (path.basename(candidate) === "package.json" || !(await isFile(candidate))) continue;
        pending.push({ file: candidate, applies, depth: depth + 1 });
      }
    }
  }
  return [...candidates];
}

const dependencyId = ([kind, target]: Dependency) => `${kind}\u0000${target}`;

async function digests(dependencies: readonly Dependency[]): Promise<Array<string | null>> {
  return Promise.all(dependencies.map(([kind, target]) => digest(kind, target)));
}

/** What a cached build was checked and bundled by, besides esbuild and the daemon. */
export interface PluginCompilerSources {
  boundaryRulesVersion: number;
  readModule(name: string): Promise<Uint8Array>;
  typescriptVersion(): Promise<string>;
}

const INSTALLED_COMPILER: PluginCompilerSources = {
  boundaryRulesVersion: PLUGIN_BOUNDARY_RULES_VERSION,
  readModule: (name) => {
    const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    return readFile(new URL(`./${name}${extension}`, import.meta.url));
  },
  async typescriptVersion() {
    const manifest = nodeRequire.resolve("typescript/package.json");
    const typescript = JSON.parse(await readFile(manifest, "utf8")) as { version?: unknown };
    return String(typescript.version);
  },
};

/** Identifies the boundary rules, the source of every compiler module, and TypeScript's version. */
export async function pluginCompilerFingerprint(
  sources: PluginCompilerSources = INSTALLED_COMPILER,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`rules\u0000${sources.boundaryRulesVersion}\u0000`);
  for (const name of COMPILER_MODULES) {
    const source = await sources.readModule(name);
    hash.update(`${name}\u0000${source.length}\u0000`);
    hash.update(source);
  }
  hash.update(`typescript\u0000${await sources.typescriptVersion()}`);
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
    recorded: { files: Iterable<string>; probes: Iterable<string>; directories: Iterable<string> },
    startedAt: number,
    before: ReadonlyMap<string, string | null>,
  ): Promise<boolean> {
    let temporary: string | null = null;
    try {
      const absolute = (paths: Iterable<string>) =>
        new Set([...paths].map((file) => path.resolve(file)));
      const inputs = absolute(recorded.files);
      const probed = absolute(recorded.probes);
      const lookups = absolute(recorded.directories);
      // Every tsconfig.json / jsconfig.json near an input, and the configs the boundary
      // check's TypeScript read for the plugin, which may extend files of any name.
      const configs: ConfigRoot[] = [
        ...describeDependencies(inputs, probed, lookups)
          .filter(([kind, target]) => kind === "file" && TS_CONFIG_FILES.has(path.basename(target)))
          .map(([, target]) => ({ file: target, applies: !insideNodeModules(target) })),
        ...[...probed]
          .filter((file) => file.endsWith(".json"))
          .map((file) => ({ file, applies: true })),
      ];
      const extended = await extendedConfigs(configs);
      if (!extended) return false;
      for (const candidate of extended) probed.add(path.resolve(candidate));
      const dependencies = describeDependencies(inputs, probed, lookups);
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
      fingerprint ??= (options.compilerFingerprint ?? pluginCompilerFingerprint)().catch(
        (error: unknown) => {
          report("key", error);
          return null;
        },
      );
      const compiler = await fingerprint;
      if (!compiler) return null;
      return sha256(
        JSON.stringify({
          format: FORMAT,
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
        store: (bundle, files, probes = [], directories = []) =>
          store(key, bundle, { files, probes, directories }, startedAt, before),
      };
    },
  };
}
