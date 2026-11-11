import { describe, expect, it, vi } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import {
  AgentSnapshotPayloadSchema,
  FetchAgentsResponseMessageSchema,
} from "@getpaseo/protocol/messages";
import {
  applySessionSettings,
  EMPTY_SESSION_SETTINGS,
  openSessionSettings,
  resolveSpeedFeature,
  resolveSpeedSetting,
  resolveSessionSettingsHostId,
  selectSessionSettingsHosts,
  saveSessionDefaults,
  withSessionSettingsHosts,
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
  it("connects scoped-out bulk targets before applying and releases every temporary connection", async () => {
    const client = new DaemonClient({
      url: "ws://unused",
      clientId: "bulk-connection-test",
      reconnect: { enabled: false },
    });
    let connected = false;
    const listeners = new Set<() => void>();
    const release = vi.fn();
    const runtime = {
      acquireConnectionDemand: vi.fn(() => release),
      getSnapshot: () => ({ connectionStatus: connected ? "online" : "connecting" }),
      getClient: () => (connected ? client : null),
      subscribe: (_id: string, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const apply = vi.fn(async (hosts) => {
      expect(release).not.toHaveBeenCalled();
      return hosts;
    });
    const result = withSessionSettingsHosts(
      { hosts: [{ serverId: "remote", label: "Remote" }], runtime },
      apply,
    );
    expect(apply).not.toHaveBeenCalled();
    expect(runtime.acquireConnectionDemand).toHaveBeenCalledWith("remote");
    connected = true;
    for (const listener of listeners) listener();
    expect(await result).toEqual([{ label: "Remote", client }]);
    expect(listeners.size).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

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
    form.select({ model: "work-model", mode: "full-access", speed: "priority" });
    form.setTarget("home");
    expect(form.getState()).toMatchObject({
      target: "home",
      provider: "",
      selection: EMPTY_SESSION_SETTINGS,
    });
  });

  it("skips only hosts still unavailable after the connection deadline", async () => {
    vi.useFakeTimers();
    try {
      const client = new DaemonClient({
        url: "ws://unused",
        clientId: "bulk-deadline-test",
        reconnect: { enabled: false },
      });
      vi.spyOn(client, "fetchAgents").mockResolvedValue({
        requestId: "empty",
        entries: [],
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      });
      const listeners = new Set<() => void>();
      const release = vi.fn();
      const apply = vi.fn((hosts) =>
        applySessionSettings({ hosts, provider: "codex", selection: EMPTY_SESSION_SETTINGS }),
      );
      const result = withSessionSettingsHosts(
        {
          hosts: [
            { serverId: "online", label: "Online" },
            { serverId: "offline", label: "Offline" },
          ],
          runtime: {
            acquireConnectionDemand: () => release,
            getSnapshot: (id) => ({ connectionStatus: id === "online" ? "online" : "offline" }),
            getClient: (id) => (id === "online" ? client : null),
            subscribe: (_id, listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
        },
        apply,
      );
      await vi.advanceTimersByTimeAsync(9999);
      expect(apply).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ applied: 0, failed: 0, skippedHosts: ["Offline"] });
      expect(client.fetchAgents).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(2);
      expect(listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases temporary connections when applying settings fails", async () => {
    const client = new DaemonClient({
      url: "ws://unused",
      clientId: "bulk-failed-apply-test",
      reconnect: { enabled: false },
    });
    const release = vi.fn();
    await expect(
      withSessionSettingsHosts(
        {
          hosts: [{ serverId: "remote", label: "Remote" }],
          runtime: {
            acquireConnectionDemand: () => release,
            getSnapshot: () => ({ connectionStatus: "online" }),
            getClient: () => client,
            subscribe: vi.fn(),
          },
        },
        async () => {
          throw new Error("apply failed");
        },
      ),
    ).rejects.toThrow("apply failed");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases earlier connections when acquiring another target fails", async () => {
    const release = vi.fn();
    const apply = vi.fn();
    await expect(
      withSessionSettingsHosts(
        {
          hosts: [
            { serverId: "first", label: "First" },
            { serverId: "second", label: "Second" },
          ],
          runtime: {
            acquireConnectionDemand: (id) => {
              if (id === "second") throw new Error("connect failed");
              return release;
            },
            getSnapshot: () => null,
            getClient: () => null,
            subscribe: vi.fn(),
          },
        },
        apply,
      ),
    ).rejects.toThrow("connect failed");
    expect(apply).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
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
      selection: { model: "new", mode: "full-access", thinking: "xhigh", speed: "default" },
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
      resolveSpeedSetting([{ type: "toggle", id: "fast_mode", label: "Fast", value: true }], "off"),
    ).toEqual({ id: "fast_mode", value: false });
    expect(resolveSpeedSetting([], "ultrafast")).toBeNull();
    expect(() =>
      saveSessionDefaults({
        preferences: {},
        provider: "claude",
        selection: { model: "", mode: "", thinking: "", speed: "on" },
        features: [],
      }),
    ).toThrow("Speed 'on' is unavailable");
  });

  it("resets selections when changing catalog host or provider", () => {
    const form = openSessionSettings();
    const changed = vi.fn();
    const unsubscribe = form.subscribe(changed);
    form.select({ model: "opus", speed: "on" });
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

  it.each(["priority", "ultrafast", "future-tier"])(
    "uses advertised speed %s verbatim and rejects it when account or model eligibility changes",
    (tier) => {
      const baseOptions = [
        { id: "default", label: "Normal" },
        { id: "priority", label: "Fast" },
      ];
      const available: AgentFeature = {
        type: "select",
        id: "service_tier",
        label: "Speed",
        value: "default",
        options: [...baseOptions.filter((option) => option.id !== tier), { id: tier, label: tier }],
      };
      expect(resolveSpeedFeature([available])).toBe(available);
      expect(resolveSpeedSetting([available], tier)).toEqual({ id: "service_tier", value: tier });
      const selection = { ...EMPTY_SESSION_SETTINGS, speed: tier };
      const preferences = {
        providerPreferences: {
          codex: { featureValues: { plan_mode: true, service_tier: "default" } },
          claude: { featureValues: { fast_mode: true } },
        },
      };
      const next = saveSessionDefaults({
        preferences,
        provider: "codex",
        selection,
        features: [available],
      });
      expect(next.providerPreferences?.codex?.featureValues).toEqual({
        plan_mode: true,
        service_tier: tier,
      });
      expect(next.providerPreferences?.claude).toEqual(preferences.providerPreferences.claude);
      const downgraded: AgentFeature = {
        ...available,
        options: available.options.filter((option) => option.id !== tier),
      };
      expect(resolveSpeedSetting([downgraded], tier)).toBeNull();
      expect(() =>
        saveSessionDefaults({ preferences, provider: "codex", selection, features: [downgraded] }),
      ).toThrow(`Speed '${tier}' is unavailable`);
      expect(preferences.providerPreferences.codex.featureValues.service_tier).toBe("default");
      expect(
        resolveSpeedSetting(
          [{ type: "toggle", id: "fast_mode", label: "Fast", value: false }],
          tier,
        ),
      ).toBeNull();
    },
  );

  it("keeps an existing ultrafast preference when only unrelated defaults change", () => {
    const preferences = {
      providerPreferences: { codex: { featureValues: { service_tier: "ultrafast" } } },
    };
    expect(
      saveSessionDefaults({
        preferences,
        provider: "codex",
        selection: { ...EMPTY_SESSION_SETTINGS, mode: "full-access" },
        features: [],
      }).providerPreferences?.codex,
    ).toEqual({ mode: "full-access", featureValues: { service_tier: "ultrafast" } });
    expect(
      resolveSpeedSetting([{ type: "toggle", id: "fast_mode", label: "Fast", value: false }], "on"),
    ).toEqual({ id: "fast_mode", value: true });
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
    form.select({ thinking: "high", mode: "full-access", speed: "ultrafast" });
    form.setModel("different-model");
    expect(form.getState().selection).toEqual({
      model: "different-model",
      mode: "full-access",
      thinking: "",
      speed: "",
    });
  });

  it.each(["priority", "ultrafast"])(
    "paginates %s updates and isolates failures without changing another provider or archived sessions",
    async (speed) => {
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
              { id: "ultrafast", label: "Ultrafast" },
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
        selection: { model: "new", mode: "full-access", thinking: "high", speed },
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
      expect(feature).toHaveBeenCalledWith("last", "service_tier", speed);

      // A different host/account/model may advertise fewer tiers than the catalog host.
      fetch.mockReset().mockResolvedValue(page([agent, { ...agent, id: "last" }], null));
      vi.mocked(client.fetchAgent).mockImplementation(async (id) => ({
        agent: { ...agent, id, cwd: id === "first" ? "/eligible" : "/restricted" },
        project: null,
      }));
      vi.mocked(client.listProviderFeatures).mockImplementation(async (config) => ({
        requestId: "eligibility-test",
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
              ...(config.cwd === "/eligible" ? [{ id: speed, label: speed }] : []),
            ],
          },
        ],
      }));
      feature.mockClear();
      const restricted = await applySessionSettings({
        hosts: [{ label: "mixed account", client }],
        provider: "codex",
        selection: { ...EMPTY_SESSION_SETTINGS, speed },
      });
      expect(restricted).toMatchObject({
        applied: 1,
        failed: 1,
        failures: [
          {
            host: "mixed account",
            session: "last",
            message: `Speed '${speed}' is unavailable for this account or model`,
          },
        ],
      });
      expect(feature).toHaveBeenCalledExactlyOnceWith("first", "service_tier", speed);
    },
  );

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

  it("preserves the bulk thinking default when saving a session selection", async () => {
    const storage = new FakeCreateAgentPreferenceStorage({
      stored: {
        provider: "codex",
        providerPreferences: { codex: { thinkingByModel: { "gpt-5.5": "low" } } },
      },
    });
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
          thinkingByModel: { "gpt-5.5": "low" },
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

  it("keeps an explicit bulk effort default when applying a different session profile", () => {
    const preferences = saveSessionDefaults({
      preferences: {},
      provider: "codex",
      selection: { ...EMPTY_SESSION_SETTINGS, model: "gpt-5.5", thinking: "low" },
      features: [],
    });
    const selected = applyAgentProfilePreferences({
      preferences,
      previousProvider: "codex",
      previousProviderModeIds: ["full-access"],
      provider: "codex",
      modelId: "gpt-5.5",
      modeId: "full-access",
      thinkingOptionId: "high",
      featureValues: {},
    });
    expect(selected.providerPreferences?.codex?.thinkingByModel).toEqual({ "gpt-5.5": "low" });
    expect(
      saveSessionDefaults({
        preferences: selected,
        provider: "codex",
        selection: { ...EMPTY_SESSION_SETTINGS, thinking: "medium" },
        features: [],
      }).providerPreferences?.codex?.thinkingByModel,
    ).toEqual({ "gpt-5.5": "medium" });
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
