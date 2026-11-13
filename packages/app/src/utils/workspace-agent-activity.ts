import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { aggregateSidebarStateBuckets, deriveSidebarStateBucket } from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
}

export function resolveWorkspaceProvider(input: {
  serverId: string;
  workspaceId: string;
  selectedAgentId: string | null;
  agents: ReadonlyMap<string, Agent> | undefined;
  activity: WorkspaceAgentActivity | undefined;
}): string | undefined {
  const providerFor = (agentId: string | null | undefined) => {
    const agent = agentId ? input.agents?.get(agentId) : undefined;
    return agent &&
      agent.serverId === input.serverId &&
      agent.workspaceId === input.workspaceId &&
      !agent.archivedAt
      ? agent.provider
      : undefined;
  };
  return providerFor(input.selectedAgentId) ?? providerFor(input.activity?.agentId);
}

function workspaceAgentStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") return "running";
  return agent.status === "running" ? "idle" : agent.status;
}

function mergeWorkspaceRootActivity(
  current: WorkspaceAgentActivity,
  incoming: WorkspaceAgentActivity,
): WorkspaceAgentActivity {
  const status = aggregateSidebarStateBuckets([current.status, incoming.status]);
  const incomingStatusTimeWins =
    status === incoming.status &&
    (current.status !== status ||
      !current.enteredAt ||
      (incoming.enteredAt && incoming.enteredAt > current.enteredAt));
  return {
    agentId: incoming.agentId,
    status,
    enteredAt: incomingStatusTimeWins ? incoming.enteredAt : current.enteredAt,
  };
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();
  const latestActivityAtByWorkspaceId = new Map<string, Date>();

  for (const agent of agents.values()) {
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    if (agent.archivedAt || !agent.workspaceId || !isWorkspaceRootAgent(agent, parentAgent)) {
      continue;
    }

    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
    const latestActivityAt = latestActivityAtByWorkspaceId.get(agent.workspaceId);
    const isLatest = !latestActivityAt || enteredAt > latestActivityAt;
    if (isLatest) latestActivityAtByWorkspaceId.set(agent.workspaceId, enteredAt);

    const status = deriveSidebarStateBucket({
      status: workspaceAgentStatus(agent),
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
    });
    const current = activityByWorkspaceId.get(agent.workspaceId);
    if (!current) {
      activityByWorkspaceId.set(agent.workspaceId, { agentId: agent.id, status, enteredAt });
      continue;
    }
    // Provider identity follows the latest root; another root's permission still needs attention.
    activityByWorkspaceId.set(
      agent.workspaceId,
      mergeWorkspaceRootActivity(current, {
        agentId: isLatest ? agent.id : current.agentId,
        status,
        enteredAt,
      }),
    );
  }

  for (const [workspaceId, activity] of activityByWorkspaceId) {
    const previousActivity = previous?.get(workspaceId);
    if (
      previousActivity?.agentId === activity.agentId &&
      previousActivity.status === activity.status
    ) {
      activityByWorkspaceId.set(workspaceId, previousActivity);
    }
  }

  if (previous && areWorkspaceAgentActivityIndexesIdentical(previous, activityByWorkspaceId)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return activityByWorkspaceId;
}

function areWorkspaceAgentActivityIndexesIdentical(
  previous: ReadonlyMap<string, WorkspaceAgentActivity>,
  next: ReadonlyMap<string, WorkspaceAgentActivity>,
): boolean {
  if (previous.size !== next.size) {
    return false;
  }
  for (const [workspaceId, activity] of next) {
    if (previous.get(workspaceId) !== activity) {
      return false;
    }
  }
  return true;
}
