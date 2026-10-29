import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runBundledSetup, getBundledDaemonVersion, getBundledUpdateFeed } from "./bundled-setup.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-offline-setup-"));
  roots.push(root);
  const resourcesPath = path.join(root, "resources");
  await mkdir(resourcesPath);
  return {
    root,
    context: {
      resourcesPath,
      executable: "Paseo",
      home: path.join(root, "home"),
      isDaemonRunning: async () => false,
    },
  };
}
test("a normal core build has no distribution setup side effects", async () => {
  const { context } = await fixture();
  const load = vi.fn();
  await runBundledSetup(context, load);
  expect(load).not.toHaveBeenCalled();
});
test("only the pinned resource script runs and a corrupted script never loads", async () => {
  const { context } = await fixture();
  const source = "export async function prepare() {}";
  const file = path.join(context.resourcesPath, "setup.mjs");
  await writeFile(file, source);
  await writeFile(
    path.join(context.resourcesPath, "bundled-setup.json"),
    JSON.stringify({
      schemaVersion: 1,
      entrypoint: "setup.mjs",
      sha256: createHash("sha256").update(source).digest("hex"),
      daemonVersion: "0.12.0",
      updateFeed: { owner: "example", repo: "distribution", private: true },
    }),
  );
  const prepare = vi.fn(async () => {});
  const load = vi.fn(async () => ({ prepare }));
  await runBundledSetup(context, load);
  expect(prepare).toHaveBeenCalledWith(context);
  expect(getBundledDaemonVersion()).toBe("0.12.0");
  expect(getBundledUpdateFeed()).toEqual({ owner: "example", repo: "distribution", private: true });
  await writeFile(file, "changed");
  await expect(runBundledSetup(context, load)).rejects.toThrow("integrity mismatch");
  expect(load).toHaveBeenCalledTimes(1);
});
test("a distribution setup cannot point outside its resources", async () => {
  const { root, context } = await fixture();
  await writeFile(path.join(root, "outside.mjs"), "outside");
  await writeFile(
    path.join(context.resourcesPath, "bundled-setup.json"),
    JSON.stringify({ schemaVersion: 1, entrypoint: "../outside.mjs", sha256: "0".repeat(64) }),
  );
  await expect(runBundledSetup(context, vi.fn())).rejects.toThrow("escapes resources");
});
