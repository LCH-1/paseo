/** @vitest-environment jsdom */
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const state = vi.hoisted(() => ({ connected: true, supported: true }));
const registry = vi.hoisted(() => ({
  installCatalog: vi.fn(),
  removeHost: vi.fn(),
}));
vi.mock("@/contexts/voice-context", () => ({
  useVoiceAudioEngineOptional: () => ({ play: async () => 0 }),
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => state.supported,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => state.connected,
}));
vi.mock("./registry", () => ({ pluginRegistry: registry }));
vi.mock("./settings/use-settings", () => ({ pluginSettingsKey: () => [] }));

import { PluginCatalogSync } from "./catalog-sync";

function createClient() {
  const getPluginCatalog = vi.fn(async () => []);
  const release = vi.fn(async () => {});
  const client = {
    getPluginCatalog,
    observeEvents: () => ({
      subscribe: ({ snapshot }: { snapshot: () => void }) => snapshot(),
      release,
    }),
  } as unknown as DaemonClient;
  return { client, getPluginCatalog, release };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.connected = true;
  state.supported = true;
});

it("keeps loaded registrations offline, refreshes on reconnect, and removes on host teardown", async () => {
  const { client, getPluginCatalog, release } = createClient();
  const view = render(<PluginCatalogSync serverId="host-a" client={client} />);
  await waitFor(() => expect(registry.installCatalog).toHaveBeenCalledTimes(1));
  state.connected = false;
  state.supported = false;
  view.rerender(<PluginCatalogSync serverId="host-a" client={client} />);
  expect(release).toHaveBeenCalledTimes(1);
  expect(registry.removeHost).not.toHaveBeenCalled();
  expect(getPluginCatalog).toHaveBeenCalledTimes(1);
  state.connected = true;
  state.supported = true;
  view.rerender(<PluginCatalogSync serverId="host-a" client={client} />);
  await waitFor(() => expect(registry.installCatalog).toHaveBeenCalledTimes(2));
  expect(registry.installCatalog.mock.calls.map((call) => call[2].replaceAll)).toEqual([
    true,
    true,
  ]);
  view.unmount();
  expect(registry.removeHost).toHaveBeenCalledExactlyOnceWith("host-a");
  expect(release).toHaveBeenCalledTimes(2);
});

it("removes registrations when the connected host disables plugin support", async () => {
  const { client } = createClient();
  const view = render(<PluginCatalogSync serverId="host-a" client={client} />);
  await waitFor(() => expect(registry.installCatalog).toHaveBeenCalledTimes(1));
  state.supported = false;
  view.rerender(<PluginCatalogSync serverId="host-a" client={client} />);
  expect(registry.removeHost).toHaveBeenCalledExactlyOnceWith("host-a");
});
