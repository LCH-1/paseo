import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { pickAttentionAgent, shouldClearAgentAttention } from "@/utils/agent-attention";
import { buildSidebarActivitySessions } from "@/components/sidebar/activity/model";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

function createAgent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  const { id, ...rest } = input;
  return {
    serverId: "server-1",
    id,
    provider: "codex",
    status: "idle",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo/worktree",
    model: null,
    parentAgentId: null,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    ...rest,
    turn: rest.turn ?? { phase: "idle", cancellationRequestId: null },
  };
}

describe("sidebar activity sessions", () => {
  const openTurn: Agent["turn"] = {
    phase: "open",
    turnId: "turn-1",
    startedAt: null,
    cancellationRequestId: null,
  };
  function session(input: Partial<Agent> & Pick<Agent, "id">): AggregatedAgent {
    const agent = createAgent({ workspaceId: "shared-workspace", ...input });
    return {
      ...agent,
      serverLabel: "Host",
      pendingPermissionCount: agent.pendingPermissions.length,
    };
  }
  function groups(agents: AggregatedAgent[], hostFilters: string[] = []) {
    return buildSidebarActivitySessions({
      agents,
      serverIds: ["server-1", "server-2"],
      hostFilters,
    });
  }
  function finished(id: string) {
    return session({ id, requiresAttention: true, attentionReason: "finished" });
  }

  it("lists sessions sharing a workspace independently and transitions from working to unreviewed", () => {
    const running = session({ id: "first", turn: openTurn });
    const completed = finished("second");
    expect(groups([running, completed])).toEqual({ running: [running], unreviewed: [completed] });
    const settled = finished("first");
    expect(groups([settled, completed])).toEqual({ running: [], unreviewed: [settled, completed] });
    const reviewed = { ...settled, requiresAttention: false };
    expect(groups([reviewed, completed])).toEqual({ running: [], unreviewed: [completed] });
  });

  it("uses the open turn instead of stale lifecycle status", () => {
    const working = session({ id: "working", status: "idle", turn: openTurn });
    const stale = session({ id: "stale", status: "running" });
    expect(groups([working, stale])).toEqual({ running: [working], unreviewed: [] });
  });

  it("excludes permission requests, errors, archived sessions and ordinary idle sessions", () => {
    const agents = [
      session({
        id: "permission",
        turn: openTurn,
        requiresAttention: true,
        attentionReason: "permission",
      }),
      session({ id: "error", requiresAttention: true, attentionReason: "error", status: "error" }),
      session({ id: "archived", turn: openTurn, archivedAt: new Date("2026-10-27") }),
      session({ id: "idle" }),
      session({ id: "unknown-reason", requiresAttention: true }),
    ];
    expect(groups(agents)).toEqual({ running: [], unreviewed: [] });
  });

  it("honors host filters, falls back for removed filters and keeps host-qualified identities", () => {
    const first = finished("same-id");
    const second = { ...first, serverId: "server-2" };
    const removed = { ...first, serverId: "removed" };
    expect(groups([first, second, removed])).toEqual({ running: [], unreviewed: [first, second] });
    expect(groups([first, second], ["server-2"])).toEqual({ running: [], unreviewed: [second] });
    expect(groups([first, second], ["removed"])).toEqual({
      running: [],
      unreviewed: [first, second],
    });
  });

  it("shows the most recently completed sessions first without changing the source", () => {
    const older = { ...finished("older"), attentionTimestamp: new Date("2026-10-26") };
    const newer = { ...finished("newer"), attentionTimestamp: new Date("2026-10-27") };
    const agents = [older, newer];
    expect(groups(agents).unreviewed).toEqual([newer, older]);
    expect(agents).toEqual([older, newer]);
  });
});

describe("shouldClearAgentAttention", () => {
  it("returns true only when the agent is connected and requires attention", () => {
    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
      }),
    ).toBe(true);
  });

  it("returns false when the app is disconnected", () => {
    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: false,
        requiresAttention: true,
        attentionReason: "finished",
      }),
    ).toBe(false);
  });

  it("returns false when attention is already clear", () => {
    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: true,
        requiresAttention: false,
        attentionReason: null,
      }),
    ).toBe(false);
  });

  it("returns false for empty agent ids", () => {
    expect(
      shouldClearAgentAttention({
        agentId: "",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
      }),
    ).toBe(false);
  });

  it("returns false for permission-shaped attention", () => {
    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "permission",
      }),
    ).toBe(false);
  });

  it("returns false for focus entry when clear was deferred while already focused", () => {
    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
        trigger: "focus-entry",
        hasDeferredFocusEntryClear: true,
      }),
    ).toBe(false);
  });

  it("returns true for explicit follow-up entrypoints after deferred focus clear", () => {
    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
        trigger: "input-focus",
        hasDeferredFocusEntryClear: true,
      }),
    ).toBe(true);

    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
        trigger: "prompt-send",
        hasDeferredFocusEntryClear: true,
      }),
    ).toBe(true);

    expect(
      shouldClearAgentAttention({
        agentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
        trigger: "agent-blur",
        hasDeferredFocusEntryClear: true,
      }),
    ).toBe(true);
  });
});

describe("pickAttentionAgent", () => {
  it("returns null for empty input", () => {
    expect(pickAttentionAgent([])).toBeNull();
  });

  it("returns null when no agent requires attention", () => {
    expect(
      pickAttentionAgent([
        createAgent({ id: "agent-1", requiresAttention: false, attentionReason: "permission" }),
        createAgent({ id: "agent-2", requiresAttention: false, attentionReason: null }),
      ]),
    ).toBeNull();
  });

  it("returns the single permission agent", () => {
    expect(
      pickAttentionAgent([
        createAgent({
          id: "agent-1",
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date("2026-01-03T00:00:00.000Z"),
        }),
      ]),
    ).toBe("agent-1");
  });

  it("prioritizes permission over error over finished", () => {
    expect(
      pickAttentionAgent([
        createAgent({
          id: "finished-agent",
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: new Date("2026-01-01T00:00:00.000Z"),
        }),
        createAgent({
          id: "error-agent",
          requiresAttention: true,
          attentionReason: "error",
          attentionTimestamp: new Date("2026-01-02T00:00:00.000Z"),
        }),
        createAgent({
          id: "permission-agent",
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date("2026-01-03T00:00:00.000Z"),
        }),
      ]),
    ).toBe("permission-agent");
  });

  it("breaks ties by oldest attention timestamp", () => {
    expect(
      pickAttentionAgent([
        createAgent({
          id: "newer-permission-agent",
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date("2026-01-03T00:00:00.000Z"),
        }),
        createAgent({
          id: "older-permission-agent",
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date("2026-01-01T00:00:00.000Z"),
        }),
      ]),
    ).toBe("older-permission-agent");
  });

  it("ignores subagents even when they require attention", () => {
    expect(
      pickAttentionAgent([
        createAgent({
          id: "subagent",
          parentAgentId: "parent-agent",
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date("2026-01-01T00:00:00.000Z"),
        }),
        createAgent({
          id: "top-level-agent",
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: new Date("2026-01-02T00:00:00.000Z"),
        }),
      ]),
    ).toBe("top-level-agent");
  });

  it("returns null when only subagents require attention", () => {
    expect(
      pickAttentionAgent([
        createAgent({
          id: "subagent",
          parentAgentId: "parent-agent",
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date("2026-01-01T00:00:00.000Z"),
        }),
      ]),
    ).toBeNull();
  });

  it("ignores agents with requiresAttention true but null reason", () => {
    expect(
      pickAttentionAgent([
        createAgent({
          id: "ignored-agent",
          requiresAttention: true,
          attentionReason: null,
          attentionTimestamp: new Date("2026-01-01T00:00:00.000Z"),
        }),
        createAgent({
          id: "error-agent",
          requiresAttention: true,
          attentionReason: "error",
          attentionTimestamp: new Date("2026-01-02T00:00:00.000Z"),
        }),
      ]),
    ).toBe("error-agent");
  });
});
