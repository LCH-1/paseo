import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import {
  buildWorkspaceAgentActivityIndex,
  resolveWorkspaceProvider,
} from "./workspace-agent-activity";

function agent(input: {
  id: string;
  workspaceId?: string;
  status?: Agent["status"];
  turn?: Agent["turn"];
  updatedAt: string;
  attentionTimestamp?: string | null;
  requiresAttention?: boolean;
  attentionReason?: Agent["attentionReason"];
  pendingPermissionCount?: number;
  archivedAt?: string | null;
  parentAgentId?: string | null;
}): Agent {
  return {
    serverId: "host-a",
    id: input.id,
    provider: "codex",
    status: input.status ?? "idle",
    turn:
      input.turn ??
      (input.status === "running"
        ? {
            phase: "open",
            turnId: "turn-1",
            startedAt: null,
            cancellationRequestId: null,
          }
        : { phase: "idle", cancellationRequestId: null }),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date(input.updatedAt),
    lastUserMessageAt: null,
    lastActivityAt: new Date(input.updatedAt),
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
    pendingPermissions: Array.from({ length: input.pendingPermissionCount ?? 0 }, (_, index) => ({
      id: `permission-${index}`,
      provider: "codex",
      name: "shell",
      kind: "tool",
      input: {},
    })),
    persistence: null,
    title: null,
    cwd: "/repo",
    workspaceId: input.workspaceId,
    model: null,
    requiresAttention: input.requiresAttention,
    attentionReason: input.attentionReason,
    attentionTimestamp: input.attentionTimestamp ? new Date(input.attentionTimestamp) : null,
    archivedAt: input.archivedAt ? new Date(input.archivedAt) : null,
    parentAgentId: input.parentAgentId ?? null,
    labels: {},
  };
}

describe("workspace agent activity index", () => {
  it("uses turn liveness for running while preserving protocol lifecycle states", () => {
    const result = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "open",
          agent({
            id: "open",
            workspaceId: "workspace-open",
            status: "idle",
            turn: {
              phase: "open",
              turnId: null,
              startedAt: null,
              cancellationRequestId: null,
            },
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
        [
          "idle-error",
          agent({
            id: "idle-error",
            workspaceId: "workspace-error",
            status: "error",
            turn: { phase: "idle", cancellationRequestId: null },
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
      ]),
    );

    expect(result.get("workspace-open")?.status).toBe("running");
    expect(result.get("workspace-error")?.status).toBe("failed");
  });

  it("keeps permission status from an older root while retaining the latest provider representative", () => {
    const permission = agent({
      id: "permission",
      workspaceId: "workspace-a",
      pendingPermissionCount: 1,
      updatedAt: "2026-06-01T10:00:00Z",
    });
    const latest = agent({
      id: "latest",
      workspaceId: "workspace-a",
      status: "running",
      updatedAt: "2026-06-01T10:05:00Z",
    });
    const first = buildWorkspaceAgentActivityIndex(
      new Map([
        [permission.id, permission],
        [latest.id, latest],
      ]),
    );
    const reversed = buildWorkspaceAgentActivityIndex(
      new Map([
        [latest.id, latest],
        [permission.id, permission],
      ]),
    );
    expect(first.get("workspace-a")).toEqual({
      agentId: "latest",
      status: "needs_input",
      enteredAt: permission.updatedAt,
    });
    expect(reversed).toEqual(first);
    const cleared = {
      ...permission,
      pendingPermissions: [],
      updatedAt: new Date("2026-06-01T10:06:00Z"),
    };
    expect(
      buildWorkspaceAgentActivityIndex(
        new Map([
          [latest.id, latest],
          [cleared.id, cleared],
        ]),
        first,
      ).get("workspace-a"),
    ).toMatchObject({ agentId: "permission", status: "running", enteredAt: latest.updatedAt });
  });

  it("keeps the latest active root agent for each workspace", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "older",
          agent({
            id: "older",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "permission",
          agent({
            id: "permission",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:01:00.000Z",
            pendingPermissionCount: 1,
          }),
        ],
        [
          "attention",
          agent({
            id: "attention",
            workspaceId: "workspace-b",
            updatedAt: "2026-06-01T10:00:00.000Z",
            attentionTimestamp: "2026-06-01T10:02:00.000Z",
            requiresAttention: true,
            attentionReason: "finished",
          }),
        ],
      ]),
    );

    expect(index).toEqual(
      new Map([
        [
          "workspace-a",
          {
            agentId: "permission",
            status: "needs_input",
            enteredAt: new Date("2026-06-01T10:01:00.000Z"),
          },
        ],
        [
          "workspace-b",
          {
            agentId: "attention",
            status: "attention",
            enteredAt: new Date("2026-06-01T10:02:00.000Z"),
          },
        ],
      ]),
    );
  });

  it("does not let archived or child agents change root workspace activity", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "child",
          agent({
            id: "child",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:03:00.000Z",
            pendingPermissionCount: 1,
            parentAgentId: "root",
          }),
        ],
        [
          "archived",
          agent({
            id: "archived",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:04:00.000Z",
            requiresAttention: true,
            attentionReason: "error",
            archivedAt: "2026-06-01T10:04:00.000Z",
          }),
        ],
      ]),
    );

    expect(index.get("workspace-a")).toEqual({
      agentId: "root",
      status: "running",
      enteredAt: new Date("2026-06-01T10:00:00.000Z"),
    });
  });

  it("treats a cross-workspace subagent as activity in its own workspace", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "parent",
          agent({
            id: "parent",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "child",
          agent({
            id: "child",
            workspaceId: "workspace-b",
            status: "running",
            updatedAt: "2026-06-01T10:03:00.000Z",
            parentAgentId: "parent",
          }),
        ],
      ]),
    );

    expect(index).toEqual(
      new Map([
        [
          "workspace-a",
          {
            agentId: "parent",
            status: "done",
            enteredAt: new Date("2026-06-01T10:00:00.000Z"),
          },
        ],
        [
          "workspace-b",
          {
            agentId: "child",
            status: "running",
            enteredAt: new Date("2026-06-01T10:03:00.000Z"),
          },
        ],
      ]),
    );
  });

  it("preserves the activity index while the same agent remains in the same status", () => {
    const previous = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
      ]),
    );

    const next = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:05:00.000Z",
          }),
        ],
      ]),
      previous,
    );

    expect(next).toBe(previous);
    expect(next.get("workspace-a")?.enteredAt).toEqual(new Date("2026-06-01T10:00:00.000Z"));
  });

  it("records a new entry time when an agent changes status", () => {
    const previous = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
      ]),
    );

    const next = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "idle",
            updatedAt: "2026-06-01T10:05:00.000Z",
            pendingPermissionCount: 1,
          }),
        ],
      ]),
      previous,
    );

    expect(next).not.toBe(previous);
    expect(next.get("workspace-a")).toEqual({
      agentId: "root",
      status: "needs_input",
      enteredAt: new Date("2026-06-01T10:05:00.000Z"),
    });
  });
});

describe("workspace provider presentation", () => {
  const latest = agent({
    id: "codex-root",
    workspaceId: "workspace-a",
    updatedAt: "2026-06-01T10:05:00.000Z",
  });
  const selected = {
    ...agent({
      id: "claude-root",
      workspaceId: "workspace-a",
      updatedAt: "2026-06-01T10:00:00.000Z",
    }),
    provider: "claude",
  };
  const agents = new Map([
    [latest.id, latest],
    [selected.id, selected],
  ]);
  const activity = buildWorkspaceAgentActivityIndex(agents).get("workspace-a");

  it("shows the selected conversation's provider even when another provider was active later", () => {
    expect(activity?.agentId).toBe(latest.id);
    expect(
      resolveWorkspaceProvider({
        serverId: "host-a",
        workspaceId: "workspace-a",
        selectedAgentId: selected.id,
        agents,
        activity,
      }),
    ).toBe("claude");
    expect(agents.get(latest.id)?.provider).toBe("codex");
  });

  it("keeps window selections independent and does not change the shared activity representative", () => {
    const input = { serverId: "host-a", workspaceId: "workspace-a", agents, activity };
    expect(resolveWorkspaceProvider({ ...input, selectedAgentId: latest.id })).toBe("codex");
    expect(resolveWorkspaceProvider({ ...input, selectedAgentId: selected.id })).toBe("claude");
    expect(activity?.agentId).toBe(latest.id);
  });

  it.each([
    { serverId: "host-b" },
    { workspaceId: "workspace-b" },
    { archivedAt: new Date("2026-06-01T11:00:00.000Z") },
  ])("ignores a selected conversation outside this active host/workspace: %j", (override) => {
    const invalid = { ...selected, ...override };
    expect(
      resolveWorkspaceProvider({
        serverId: "host-a",
        workspaceId: "workspace-a",
        selectedAgentId: invalid.id,
        agents: new Map([
          [latest.id, latest],
          [invalid.id, invalid],
        ]),
        activity,
      }),
    ).toBe("codex");
  });

  it.each([null, "missing-agent"])(
    "uses the representative when a terminal/file or missing conversation is selected: %s",
    (selectedAgentId) => {
      expect(
        resolveWorkspaceProvider({
          serverId: "host-a",
          workspaceId: "workspace-a",
          selectedAgentId,
          agents,
          activity,
        }),
      ).toBe("codex");
    },
  );

  it("shows no provider when neither selection nor representative belongs to this workspace", () => {
    expect(
      resolveWorkspaceProvider({
        serverId: "host-b",
        workspaceId: "workspace-a",
        selectedAgentId: selected.id,
        agents,
        activity,
      }),
    ).toBeUndefined();
  });
});
