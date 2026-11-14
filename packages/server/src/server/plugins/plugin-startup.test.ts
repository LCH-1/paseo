import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { BuiltinPluginLoader } from "./builtin/index.js";
import { pluginImportWorkerStats } from "./compiler-imports-pool.js";
import { PluginService } from "./index.js";
import { PluginRuntime } from "./runtime.js";
import type { PluginSessionSocket } from "./session-socket.js";

type TestPluginRuntime = NonNullable<
  NonNullable<ConstructorParameters<typeof PluginService>[3]>["runtime"]
>;
type PluginSources = Record<string, { source: "directory"; path: string; enabled?: boolean }>;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

function createStore(home: string, plugins: PluginSources): DaemonConfigStore {
  return new DaemonConfigStore(home, {
    mcp: { injectIntoAgents: true },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    pluginsEnabled: true,
    plugins,
  });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const providerIds = (service: PluginService) =>
  service
    .getProviderRegistrations()
    .map(({ id }) => id)
    .join(",");

const markerSource = (marker: string) =>
  `export default function contribute() { return () => ${JSON.stringify(marker)}; }`;

type MarkedChild = EventEmitter & {
  connected: boolean;
  killed: boolean;
  stdout: PassThrough;
  stderr: PassThrough;
  send(
    message: { type: string; bundle?: string },
    callback?: (error: Error | null) => void,
  ): boolean;
  kill(): boolean;
  disconnect(): void;
};

/** A plugin service on the real runtime and compiler whose children only record their bundle. */
async function createMarkedService(manifest: object) {
  const home = await temporaryDirectory("paseo-plugin-startup-");
  const directory = await temporaryDirectory("paseo-plugin-startup-plugin-");
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(directory, "index.server.ts"), markerSource("first marker"));
  const bundles: string[] = [];
  const close = (child: MarkedChild) => {
    child.connected = false;
    queueMicrotask(() => child.emit("close", 0, null));
  };
  const spawnChild = () => {
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      killed: false,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as MarkedChild;
    child.send = (message, callback) => {
      callback?.(null);
      if (message.type === "initialize") {
        bundles.push(message.bundle ?? "");
        queueMicrotask(() => child.emit("message", { type: "ready", methods: [], providers: [] }));
      }
      if (message.type === "shutdown") close(child);
      return true;
    };
    child.kill = () => {
      child.killed = true;
      close(child);
      return true;
    };
    child.disconnect = () => {
      child.connected = false;
    };
    return child;
  };
  const runtime = new PluginRuntime(pino({ level: "silent" }), "0.4.0", {
    spawnChild,
    sessionHost: {
      async attachPluginSocket(_pluginId: string, socket: PluginSessionSocket) {
        return { closed: new Promise<void>((resolve) => socket.once("close", () => resolve())) };
      },
    },
  });
  const service = new PluginService(
    pino({ level: "silent" }),
    createStore(home, { marked: { source: "directory", path: directory } }),
    "0.4.0",
    { runtime },
  );
  return { service, directory, bundles };
}

describe("plugin startup", () => {
  it("loads plugins side by side but publishes them in list order, built-ins first", async () => {
    const home = await temporaryDirectory("paseo-plugin-startup-");
    const builtinIds = ["b0", "b1", "b2", "b3", "b4", "b5"];
    const configuredIds = ["c0", "c1", "c2"];
    // Later plugins finish loading first.
    const delay = (id: string) => 10 * (5 - Number(id.slice(1)));
    const events: string[] = [];
    const discovered: string[] = [];
    const running = new Set<string>();
    let loading = 0;
    let peak = 0;
    const load = async (id: string, waitTurn?: () => Promise<void>) => {
      events.push(`load:${id}`);
      loading += 1;
      peak = Math.max(peak, loading);
      await pause(delay(id));
      loading -= 1;
      if (id === "c1") throw new Error("c1 failed to load");
      await waitTurn?.();
      running.add(id);
      events.push(`publish:${id}`);
    };
    const runtime: TestPluginRuntime = {
      getUsageSourceRegistrations: (id) => [{ id: `${id}-usage`, label: id }],
      fetchUsage: async () => undefined,
      discoverUsage: async (_pluginId, sourceId) => {
        discovered.push(sourceId);
        return [];
      },
      catalog: () => [...running].map((id) => ({ id, clientBundle: "" })),
      invoke: async () => undefined,
      getLogs: () => [],
      clearLogs: () => undefined,
      getProviderRegistrations: (id) =>
        id === "b1" || id === "b4" ? [{ id: `${id}-provider`, label: id }] : [],
      startBuiltinPlugin: (plugin, waitTurn) => load(plugin.id, waitTurn),
      startPlugin: (id, _path, canPublish, waitTurn) =>
        load(id, async () => {
          await waitTurn?.();
          if (!canPublish()) throw new Error(`Plugin start cancelled: ${id}`);
        }),
      stopPluginById: async (id) => running.delete(id),
      stopAll: async () => running.clear(),
      subscribe: () => () => undefined,
      bindPaseoSessionHost: () => undefined,
      connectProvider: async () => {
        throw new Error("No provider connections in this test");
      },
    };
    const service = new PluginService(
      pino({ level: "silent" }),
      createStore(
        home,
        Object.fromEntries(
          configuredIds.map((id) => [id, { source: "directory", path: path.join(home, id) }]),
        ),
      ),
      "0.4.0",
      { runtime, builtinPlugins: new BuiltinPluginLoader(path.join(home, "builtins"), builtinIds) },
    );
    const notified: string[] = [];
    service.subscribe((id) => notified.push(id));
    service.subscribeProviderRegistrations(() => events.push(`providers:${providerIds(service)}`));

    await service.start();

    expect(events.filter((event) => !event.startsWith("load:"))).toEqual([
      "publish:b0",
      "publish:b1",
      "providers:b1-provider",
      "publish:b2",
      "publish:b3",
      "publish:b4",
      "providers:b1-provider,b4-provider",
      "publish:b5",
      "publish:c0",
      "publish:c2",
    ]);
    expect(events.indexOf("load:c0")).toBeGreaterThan(events.indexOf("publish:b5"));
    expect(events.indexOf("load:b1")).toBeLessThan(events.indexOf("publish:b0"));
    expect(peak).toBe(4);
    expect(notified).toEqual(["c0", "c1", "c2"]);
    expect(await service.listPlugins()).toMatchObject([
      { id: "c0", status: "running" },
      { id: "c1", status: "failed", error: "c1 failed to load" },
      { id: "c2", status: "running" },
    ]);
    await service.listUsageReports();
    expect(discovered).toEqual(
      ["b0", "b1", "b2", "b3", "b4", "b5", "c0", "c2"].map((id) => `${id}-usage`),
    );
  });

  it("compiles a configured plugin once at startup and afresh when reloaded", async () => {
    const { service, directory, bundles } = await createMarkedService({ id: "marked" });
    const before = pluginImportWorkerStats();

    await service.start();

    const after = pluginImportWorkerStats();
    expect(
      after.workerReaders + after.inThreadReaders - before.workerReaders - before.inThreadReaders,
    ).toBe(1);
    expect(bundles).toEqual([expect.stringContaining("first marker")]);

    await writeFile(path.join(directory, "index.server.ts"), markerSource("second marker"));
    await service.reloadPlugin("marked");

    expect(bundles).toHaveLength(2);
    expect(bundles[1]).toContain("second marker");
    await service.stopAllPlugins();
  });

  it("does not reuse a startup compile for a plugin that failed before compiling", async () => {
    const { service, directory, bundles } = await createMarkedService({
      id: "marked",
      requirements: { paseo: ">=99.0.0" },
    });
    const before = pluginImportWorkerStats();
    await service.start();
    expect(await service.listPlugins()).toMatchObject([{ id: "marked", status: "failed" }]);
    // The compile started ahead of the refused start finishes before the plugin changes.
    await expect
      .poll(() => {
        const stats = pluginImportWorkerStats();
        const opened = stats.workerReaders + stats.inThreadReaders;
        return (
          opened > before.workerReaders + before.inThreadReaders && stats.openWorkerReaders === 0
        );
      })
      .toBe(true);

    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "marked" }));
    await writeFile(path.join(directory, "index.server.ts"), markerSource("second marker"));
    await service.reloadPlugin("marked");

    expect(bundles).toEqual([expect.stringContaining("second marker")]);
    await service.stopAllPlugins();
  });
});
