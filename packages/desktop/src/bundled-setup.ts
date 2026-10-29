import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface BundledSetupContext {
  resourcesPath: string;
  executable: string;
  home: string;
  isDaemonRunning(): Promise<boolean>;
}

let daemonVersion: string | null = null;
let updateFeed: { owner: string; repo: string; private: true } | null = null;
export const getBundledDaemonVersion = () => daemonVersion;
export const getBundledUpdateFeed = () => updateFeed;

function parseUpdateFeed(feed: unknown): typeof updateFeed {
  if (feed === undefined) return null;
  if (!feed || typeof feed !== "object") throw new Error("Invalid bundled update feed");
  const owner = Reflect.get(feed, "owner");
  const repo = Reflect.get(feed, "repo");
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    !/^[\w.-]+$/.test(owner) ||
    !/^[\w.-]+$/.test(repo) ||
    Reflect.get(feed, "private") !== true
  )
    throw new Error("Invalid bundled update feed");
  return { owner, repo, private: true };
}

/** Distributions may ship a pinned offline setup without embedding it in core. */
export async function runBundledSetup(
  context: BundledSetupContext,
  load: (url: string) => Promise<{ prepare?: (context: BundledSetupContext) => Promise<void> }> = (
    url,
  ) => import(url),
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path.join(context.resourcesPath, "bundled-setup.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Invalid bundled setup manifest");
  const entrypoint = Reflect.get(value, "entrypoint");
  const sha256 = Reflect.get(value, "sha256");
  if (
    Reflect.get(value, "schemaVersion") !== 1 ||
    typeof entrypoint !== "string" ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw new Error("Invalid bundled setup manifest");
  const root = await realpath(context.resourcesPath);
  const entry = await realpath(path.resolve(root, entrypoint));
  if (!entry.startsWith(root + path.sep)) throw new Error("Bundled setup escapes resources");
  const bytes = await readFile(entry);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Error("Bundled setup integrity mismatch");
  }
  const runtimeVersion = Reflect.get(value, "daemonVersion");
  if (runtimeVersion !== undefined) {
    if (
      typeof runtimeVersion !== "string" ||
      !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(runtimeVersion)
    )
      throw new Error("Invalid bundled daemon version");
  }
  const feed = parseUpdateFeed(Reflect.get(value, "updateFeed"));
  const setup = await load(pathToFileURL(entry).href);
  if (typeof setup.prepare !== "function") throw new Error("Bundled setup has no prepare function");
  await setup.prepare(context);
  daemonVersion = runtimeVersion ?? null;
  updateFeed = feed;
}
