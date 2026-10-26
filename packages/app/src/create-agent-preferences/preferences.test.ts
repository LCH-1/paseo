import { describe, expect, it, vi } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  AgentSnapshotPayloadSchema,
  FetchAgentsResponseMessageSchema,
} from "@getpaseo/protocol/messages";
import {
  applySessionSettings,
  EMPTY_SESSION_SETTINGS,
  openSessionSettings,
  resolveFastSetting,
  resolveSessionSettingsHostId,
  selectSessionSettingsHosts,
  saveSessionDefaults,
} from "@/screens/settings/session/model";
import { CreateAgentPreferencesService } from "./service";
import {
  applyAgentProfilePreferences,
  mergeCreateAgentSelectionPreferences,
  mergeProviderPreferences,
  parseFormPreferences,
} from "./preferences";
import { FakeCreateAgentPreferenceStorage } from "./test-utils/fake-preference-storage";

describe("create agent preferences", () => {
  it("uses explicit target host IDs independently of the model catalog host", () => {
    const hosts = [
      { serverId: "work", label: "Work" },
      { serverId: "home", label: "Home" },
    ];
    expect(resolveSessionSettingsHostId({ hosts, target: "all", hostId: "home" })).toBe("home");
    expect(resolveSessionSettingsHostId({ hosts, target: "work", hostId: "home" })).toBe("work");
    expect(selectSessionSettingsHosts({ hosts, target: "work" })).toEqual([hosts[0]]);
    expect(selectSessionSettingsHosts({ hosts, target: "all" })).toEqual(hosts);
    const form = openSessionSettings();
    form.select({ model: "work-model", mode: "full-access", fast: "on" });
    form.setTarget("home");
    expect(form.getState()).toMatchObject({
      target: "home",
      provider: "",
      selection: EMPTY_SESSION_SETTINGS,
    });
  });

  it("saves bulk defaults without erasing thinking, features, or other providers", () => {
    const next = saveSessionDefaults({
      preferences: {
        isolation: "worktree",
        providerPreferences: {
          claude: { model: "opus" },
          codex: {
            model: "old",
            thinkingByModel: { old: "high" },
            featureValues: { plan_mode: true },
          },
        },
      },
      provider: "codex",
      selection: { model: "new", mode: "full-access", thinking: "xhigh", fast: "off" },
      features: [
        {
          type: "select",
          id: "service_tier",
          label: "Speed",
          value: "priority",
          options: [
            { id: "default", label: "Normal" },
            { id: "priority", label: "Fast" },
          ],
        },
      ],
    });
    expect(parseFormPreferences(next)).toEqual({
      provider: "codex",
      isolation: "worktree",
      providerPreferences: {
        claude: { model: "opus" },
        codex: {
          model: "new",
          mode: "full-access",
          thinkingByModel: { old: "high", new: "xhigh" },
          featureValues: { plan_mode: true, service_tier: "default" },
        },
      },
    });
  });

  it("keeps unchanged defaults and supports both Fast representations", () => {
    expect(
      saveSessionDefaults({
        preferences: {
          providerPreferences: {
            claude: { model: "opus", mode: "default", featureValues: { fast_mode: true } },
          },
        },
        provider: "claude",
        selection: EMPTY_SESSION_SETTINGS,
        features: [],
      }).providerPreferences?.claude,
    ).toEqual({ model: "opus", mode: "default", featureValues: { fast_mode: true } });
    expect(
      resolveFastSetting([{ type: "toggle", id: "fast_mode", label: "Fast", value: true }], false),
    ).toEqual({ id: "fast_mode", value: false });
    expect(resolveFastSetting([], true)).toBeNull();
    expect(() =>
      saveSessionDefaults({
        preferences: {},
        provider: "claude",
        selection: { model: "", mode: "", thinking: "", fast: "on" },
        features: [],
      }),
    ).toThrow("Fast is unavailable");
  });

  it("resets selections when changing catalog host or provider", () => {
    const form = openSessionSettings();
    const changed = vi.fn();
    const unsubscribe = form.subscribe(changed);
    form.select({ model: "opus", fast: "on" });
    form.setProvider("codex");
    expect(form.getState().selection).toEqual(EMPTY_SESSION_SETTINGS);
    form.select({ mode: "full-access" });
    form.setHost("other-host");
    expect(form.getState()).toMatchObject({
      hostId: "other-host",
      provider: "",
      selection: EMPTY_SESSION_SETTINGS,
    });
    expect(changed).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("stores thinking against the effective model and clears it when selecting another model", () => {
    const next = saveSessionDefaults({
      preferences: {},
      provider: "codex",
      selection: { ...EMPTY_SESSION_SETTINGS, thinking: "high" },
      features: [],
      modelId: "effective-model",
    });
    expect(next.providerPreferences?.codex).toEqual({
      thinkingByModel: { "effective-model": "high" },
    });
    const form = openSessionSettings();
    form.select({ thinking: "high", mode: "full-access", fast: "on" });
    form.setModel("different-model");
    expect(form.getState().selection).toEqual({
      model: "different-model",
      mode: "full-access",
      thinking: "",
      fast: "keep",
    });
  });

  it("paginates bulk updates, isolates failures, and never changes another provider or archived sessions", async () => {
    const client = new DaemonClient({
      url: "ws://unused",
      clientId: "bulk-settings-test",
      reconnect: { enabled: false },
    });
    const agent = AgentSnapshotPayloadSchema.parse({
      id: "first",
      provider: "codex",
      cwd: "/repo",
      model: "old",
      createdAt: "2026-10-26T00:00:00Z",
      updatedAt: "2026-10-26T00:00:00Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: "default",
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
    });
    function page(agents: (typeof agent)[], nextCursor: string | null) {
      return FetchAgentsResponseMessageSchema.parse({
        type: "fetch_agents_response",
        payload: {
          requestId: "test",
          entries: agents.map((snapshot) => ({
            agent: snapshot,
            project: {
              projectKey: "/repo",
              projectName: "repo",
              checkout: {
                cwd: "/repo",
                isGit: false,
                currentBranch: null,
                remoteUrl: null,
                isPaseoOwnedWorktree: false,
                mainRepoRoot: null,
              },
            },
          })),
          pageInfo: { nextCursor, prevCursor: null, hasMore: Boolean(nextCursor) },
        },
      }).payload;
    }
    const fetch = vi
      .spyOn(client, "fetchAgents")
      .mockResolvedValueOnce(
        page(
          [
            agent,
            { ...agent, id: "other-provider", provider: "claude" },
            { ...agent, id: "archived", archivedAt: "2026-10-25T00:00:00Z" },
          ],
          "next",
        ),
      )
      .mockResolvedValueOnce(
        page(
          [
            { ...agent, id: "broken" },
            { ...agent, id: "missing-directory" },
            { ...agent, id: "last" },
          ],
          null,
        ),
      );
    const calls: string[] = [];
    vi.spyOn(client, "setAgentModel").mockImplementation(async (id) => {
      calls.push(`${id}:model`);
      if (id === "broken") throw new Error("model rejected");
      if (id === "missing-directory")
        throw new Error("Working directory does not exist: /missing-project");
    });
    vi.spyOn(client, "setAgentMode").mockImplementation(async (id) => {
      calls.push(`${id}:mode`);
      return null;
    });
    vi.spyOn(client, "setAgentThinkingOption").mockImplementation(async (id, option) => {
      calls.push(`${id}:thinking:${option}`);
      return null;
    });
    vi.spyOn(client, "fetchAgent").mockImplementation(async () => ({
      agent: { ...agent, model: "new" },
      project: null,
    }));
    vi.spyOn(client, "listProviderFeatures").mockResolvedValue({
      requestId: "features-test",
      fetchedAt: "2026-10-26T00:00:00Z",
      provider: "codex",
      features: [
        {
          type: "select",
          id: "service_tier",
          label: "Speed",
          value: "default",
          options: [
            { id: "default", label: "Normal" },
            { id: "priority", label: "Fast" },
          ],
        },
      ],
    });
    const feature = vi.spyOn(client, "setAgentFeature").mockImplementation(async (id) => {
      calls.push(`${id}:fast`);
    });
    const result = await applySessionSettings({
      hosts: [
        { label: "online", client },
        { label: "offline", client: null },
      ],
      provider: "codex",
      selection: { model: "new", mode: "full-access", thinking: "high", fast: "on" },
    });
    expect(result).toMatchObject({
      applied: 2,
      failed: 2,
      skippedHosts: ["offline"],
      failures: [
        { host: "online", session: "broken", message: "model rejected" },
        {
          host: "online",
          session: "missing-directory",
          message: "Working directory does not exist: /missing-project",
        },
      ],
    });
    expect(fetch).toHaveBeenLastCalledWith({
      filter: { includeArchived: false },
      page: { limit: 200, cursor: "next" },
    });
    expect(calls).toEqual([
      "first:model",
      "first:mode",
      "first:thinking:high",
      "first:fast",
      "broken:model",
      "missing-directory:model",
      "last:model",
      "last:mode",
      "last:thinking:high",
      "last:fast",
    ]);
    expect(feature).toHaveBeenCalledWith("last", "service_tier", "priority");
  });

  it("keeps the selected mode after saving model and thinking", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const modelWrite = preferences.update((current) =>
      mergeProviderPreferences({
        preferences: current,
        provider: "codex",
        updates: { model: "gpt-5.5", thinkingByModel: { "gpt-5.5": "high" } },
      }),
    );
    await storage.nextWrite();

    const modeWrite = preferences.update((current) =>
      mergeProviderPreferences({
        preferences: current,
        provider: "codex",
        updates: { mode: "full-access" },
      }),
    );

    expect(storage.pendingWriteCount()).toBe(1);
    storage.finishOldestWrite();
    await modelWrite;

    await storage.nextWrite();
    storage.finishOldestWrite();
    await modeWrite;

    expect(storage.savedPreferences()).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.5",
          thinkingByModel: { "gpt-5.5": "high" },
          mode: "full-access",
        },
      },
    });
  });

  it("does not commit a failed write or leak it into the next update", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const failedWrite = preferences.update({ provider: "claude" });
    await storage.nextWrite();
    storage.failOldestWrite(new Error("disk full"));
    await expect(failedWrite).rejects.toThrow("disk full");

    expect(await preferences.load()).toEqual({});

    const successfulWrite = preferences.update({ isolation: "worktree" });
    await storage.nextWrite();
    storage.finishOldestWrite();
    await successfulWrite;

    expect(storage.savedPreferences()).toEqual({ isolation: "worktree" });
  });

  it("flushes the full create-agent selection into provider preferences", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const saveSelection = preferences.update((current) =>
      mergeCreateAgentSelectionPreferences({
        preferences: current,
        provider: "codex",
        modelId: "gpt-5.5",
        modeId: "full-access",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
      }),
    );

    await storage.nextWrite();
    storage.finishOldestWrite();
    await saveSelection;

    expect(storage.savedPreferences()).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.5",
          mode: "full-access",
          thinkingByModel: { "gpt-5.5": "high" },
          featureValues: { fast_mode: true },
        },
      },
    });
  });

  it("does not erase a saved mode when a later partial update has no mode", () => {
    expect(
      mergeProviderPreferences({
        preferences: {
          provider: "codex",
          providerPreferences: {
            codex: {
              model: "gpt-5.5",
              mode: "full-access",
              thinkingByModel: { "gpt-5.5": "high" },
            },
          },
        },
        provider: "codex",
        updates: {
          model: "gpt-5.6",
          mode: undefined,
          thinkingByModel: undefined,
          featureValues: undefined,
        },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.6",
          mode: "full-access",
          thinkingByModel: { "gpt-5.5": "high" },
        },
      },
    });
  });

  it("erases a saved mode when a complete selection explicitly has no mode", () => {
    expect(
      mergeCreateAgentSelectionPreferences({
        preferences: {
          provider: "pi",
          providerPreferences: { pi: { model: "anthropic/sonnet", mode: "full-access" } },
        },
        provider: "pi",
        modelId: "anthropic/sonnet",
        modeId: null,
      }),
    ).toEqual({
      provider: "pi",
      providerPreferences: { pi: { model: "anthropic/sonnet" } },
    });
  });

  it("repairs the previous provider while applying a profile", () => {
    expect(
      applyAgentProfilePreferences({
        preferences: {
          provider: "pi",
          providerPreferences: {
            pi: { model: "anthropic/sonnet", mode: "full-access" },
            mock: { model: "ten-second-stream", mode: "load-test" },
          },
        },
        previousProvider: "pi",
        previousProviderModeIds: [],
        provider: "mock",
        modelId: "one-minute-stream",
        modeId: "approval-test",
        thinkingOptionId: "",
        featureValues: {},
      }),
    ).toEqual({
      provider: "mock",
      providerPreferences: {
        pi: { model: "anthropic/sonnet" },
        mock: { model: "one-minute-stream", mode: "approval-test", featureValues: {} },
      },
    });
  });

  it("loads invalid stored preferences as empty preferences", () => {
    expect(parseFormPreferences({ providerPreferences: { codex: { mode: 42 } } })).toEqual({});
  });

  it("strips the explicitly supported legacy location fields", () => {
    expect(
      parseFormPreferences({
        workingDir: "/old/workspace",
        provider: "codex",
        providerPreferences: {
          codex: {
            model: "gpt-5.4-mini",
            mode: "full-access",
            thinkingOptionId: "high",
          },
        },
        serverId: "old-host",
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.4-mini",
          mode: "full-access",
          thinkingByModel: { "gpt-5.4-mini": "high" },
        },
      },
    });
  });

  it("rejects unknown persisted fields outside the explicit legacy shape", () => {
    expect(parseFormPreferences({ provider: "codex", surprise: true })).toEqual({});
  });

  it("persists and reloads the workspace isolation choice", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const save = preferences.update({ isolation: "worktree" });
    await storage.nextWrite();
    storage.finishOldestWrite();
    await save;

    expect(storage.savedPreferences()).toEqual({ isolation: "worktree" });
    expect(await new CreateAgentPreferencesService(storage).load()).toEqual({
      isolation: "worktree",
    });
  });

  it("preserves legacy favourites across preference writes until host migration", async () => {
    const favoriteModels = [{ provider: "claude", modelId: "opus" }];
    const storage = new FakeCreateAgentPreferenceStorage({ stored: { favoriteModels } });
    const preferences = new CreateAgentPreferencesService(storage);

    const save = preferences.update({ isolation: "worktree" });
    await storage.nextWrite();
    storage.finishOldestWrite();
    await save;

    expect(storage.savedPreferences()).toEqual({ favoriteModels, isolation: "worktree" });
  });

  it("treats stored preferences without an isolation choice as undefined", () => {
    expect(parseFormPreferences({ provider: "codex" }).isolation).toBeUndefined();
  });

  it("rejects an unknown isolation value as invalid stored preferences", () => {
    expect(parseFormPreferences({ provider: "codex", isolation: "sandbox" })).toEqual({});
  });

  it("persists and reloads a terminal launch target", async () => {
    const storage = new FakeCreateAgentPreferenceStorage();
    const preferences = new CreateAgentPreferencesService(storage);

    const save = preferences.update({ launchTarget: { kind: "terminal", profileId: "claude" } });
    await storage.nextWrite();
    storage.finishOldestWrite();
    await save;

    expect(storage.savedPreferences()).toEqual({
      launchTarget: { kind: "terminal", profileId: "claude" },
    });
    expect(await new CreateAgentPreferencesService(storage).load()).toEqual({
      launchTarget: { kind: "terminal", profileId: "claude" },
    });
  });

  it("treats stored preferences without a launch target as undefined, defaulting to chat", () => {
    expect(parseFormPreferences({ provider: "codex" }).launchTarget).toBeUndefined();
  });

  it("rejects a terminal launch target missing a profileId as invalid stored preferences", () => {
    expect(parseFormPreferences({ launchTarget: { kind: "terminal" } })).toEqual({});
  });

  it("rejects an unknown launch target kind as invalid stored preferences", () => {
    expect(parseFormPreferences({ launchTarget: { kind: "shell" } })).toEqual({});
  });
});
