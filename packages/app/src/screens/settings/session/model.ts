import type { DaemonClient, FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type {
  AgentFeature,
  AgentProvider,
  AgentSessionConfig,
} from "@getpaseo/protocol/agent-types";
import { FAST_MODE_FEATURE_ID, SPEED_FEATURE_ID } from "@/agent-controls/policy";
import {
  mergeProviderPreferences,
  type FormPreferences,
} from "@/create-agent-preferences/preferences";

export interface SessionSettingsSelection {
  model: string;
  mode: string;
  fast: "keep" | "on" | "off";
}

export const EMPTY_SESSION_SETTINGS: SessionSettingsSelection = {
  model: "",
  mode: "",
  fast: "keep",
};

export function openSessionSettings() {
  let state = { hostId: "", provider: "", target: "all", selection: EMPTY_SESSION_SETTINGS };
  const listeners = new Set<() => void>();
  function publish(next: typeof state) {
    state = next;
    for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setHost(hostId: string) {
      publish({ ...state, hostId, provider: "", selection: EMPTY_SESSION_SETTINGS });
    },
    setProvider(provider: string) {
      publish({ ...state, provider, selection: EMPTY_SESSION_SETTINGS });
    },
    setTarget(target: string) {
      publish({ ...state, target, provider: "", selection: EMPTY_SESSION_SETTINGS });
    },
    select(selection: Partial<SessionSettingsSelection>) {
      publish({ ...state, selection: { ...state.selection, ...selection } });
    },
  };
}

interface TargetHost {
  serverId: string;
}

export function resolveSessionSettingsHostId(input: {
  target: string;
  hostId: string;
  hosts: readonly TargetHost[];
}) {
  if (input.target !== "all") return input.target;
  return input.hostId || input.hosts[0]?.serverId || "";
}

export function selectSessionSettingsHosts<Host extends TargetHost>(input: {
  target: string;
  hosts: Host[];
}) {
  return input.target === "all"
    ? input.hosts
    : input.hosts.filter((host) => host.serverId === input.target);
}

export function hasSessionSettings(selection: SessionSettingsSelection) {
  return Boolean(selection.model || selection.mode || selection.fast !== "keep");
}

export function resolveFastSetting(features: readonly AgentFeature[], enabled: boolean) {
  const toggle = features.find(
    (feature) => feature.id === FAST_MODE_FEATURE_ID && feature.type === "toggle",
  );
  if (toggle) return { id: toggle.id, value: enabled };
  const speed = features.find(
    (feature) => feature.id === SPEED_FEATURE_ID && feature.type === "select",
  );
  if (!speed || speed.type !== "select") return null;
  const fast =
    speed.options.find((option) => option.id === "fast") ??
    speed.options.find((option) => option.id !== "default");
  const normal = speed.options.find((option) => option.id === "default");
  const option = enabled ? fast : normal;
  return option ? { id: speed.id, value: option.id } : null;
}

export function saveSessionDefaults(input: {
  preferences: FormPreferences;
  provider: AgentProvider;
  selection: SessionSettingsSelection;
  features: readonly AgentFeature[];
}) {
  const { selection } = input;
  const fast = resolveFastSetting(input.features, selection.fast === "on");
  if (selection.fast !== "keep" && !fast) throw new Error("Fast is unavailable for this model");
  return mergeProviderPreferences({
    preferences: input.preferences,
    provider: input.provider,
    updates: {
      model: selection.model || undefined,
      mode: selection.mode || undefined,
      ...(selection.fast !== "keep" && fast ? { featureValues: { [fast.id]: fast.value } } : {}),
    },
  });
}

export interface SessionSettingsHost {
  label: string;
  client: DaemonClient | null;
}

export interface SessionSettingsFailure {
  host: string;
  session: string;
  message: string;
}

export interface SessionSettingsResult {
  applied: number;
  failed: number;
  failures: SessionSettingsFailure[];
  skippedHosts: string[];
  notices: string[];
}

async function applySession(input: {
  client: DaemonClient;
  agentId: string;
  selection: SessionSettingsSelection;
}) {
  const { client, agentId, selection } = input;
  const notices: string[] = [];
  // Feature availability can change with the model; read it after the model update.
  if (selection.model) await client.setAgentModel(agentId, selection.model);
  if (selection.mode) {
    const notice = await client.setAgentMode(agentId, selection.mode);
    if (notice) notices.push(notice.message);
  }
  if (selection.fast !== "keep") {
    const snapshot = await client.fetchAgent(agentId);
    if (!snapshot) throw new Error("Session no longer exists");
    const agent = snapshot.agent;
    const config: AgentSessionConfig = { provider: agent.provider, cwd: agent.cwd };
    if (agent.model) config.model = agent.model;
    if (agent.currentModeId) config.modeId = agent.currentModeId;
    const payload = await client.listProviderFeatures(config);
    if (payload.error) throw new Error(payload.error);
    const fast = resolveFastSetting(payload.features ?? [], selection.fast === "on");
    if (!fast) throw new Error("Fast is unavailable for this model");
    await client.setAgentFeature(agentId, fast.id, fast.value);
  }
  return notices;
}

async function loadTargets(client: DaemonClient, provider: AgentProvider) {
  const targets = new Map<string, FetchAgentsEntry["agent"]>();
  let cursor: string | undefined;
  do {
    const page = await client.fetchAgents({
      filter: { includeArchived: false },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const entry of page.entries) {
      const matches = entry.agent.provider === provider && !entry.agent.archivedAt;
      if (matches) targets.set(entry.agent.id, entry.agent);
    }
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return targets;
}

export async function applySessionSettings(input: {
  hosts: SessionSettingsHost[];
  provider: AgentProvider;
  selection: SessionSettingsSelection;
}): Promise<SessionSettingsResult> {
  const result: SessionSettingsResult = {
    applied: 0,
    failed: 0,
    failures: [],
    skippedHosts: [],
    notices: [],
  };
  for (const host of input.hosts) {
    const client = host.client;
    if (!client) {
      result.skippedHosts.push(host.label);
      continue;
    }
    try {
      const targets = await loadTargets(client, input.provider);
      // Updating sessions can change the directory sort order and invalidate page cursors.
      for (const agent of targets.values()) {
        try {
          const notices = await applySession({
            client,
            agentId: agent.id,
            selection: input.selection,
          });
          result.applied += 1;
          result.notices.push(...notices);
        } catch (error) {
          result.failed += 1;
          result.failures.push({
            host: host.label,
            session: agent.title ?? agent.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      result.failures.push({
        host: host.label,
        session: "",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
