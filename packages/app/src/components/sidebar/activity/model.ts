import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";

export type SidebarActivityView = "all" | "running" | "unreviewed";

export interface SidebarActivitySessions {
  running: AggregatedAgent[];
  unreviewed: AggregatedAgent[];
}

export function buildSidebarActivitySessions(input: {
  agents: readonly AggregatedAgent[];
  serverIds: readonly string[];
  hostFilters: readonly string[];
}): SidebarActivitySessions {
  const configuredHosts = new Set(input.serverIds);
  const selectedHosts = input.hostFilters.filter((id) => configuredHosts.has(id));
  const visibleHosts = new Set(selectedHosts.length > 0 ? selectedHosts : input.serverIds);
  const groups: SidebarActivitySessions = { running: [], unreviewed: [] };
  for (const agent of input.agents) {
    if (agent.archivedAt || !visibleHosts.has(agent.serverId)) continue;
    let status = agent.status;
    if (agent.turn.phase === "open") status = "running";
    else if (status === "running") status = "idle";
    const bucket = deriveSidebarStateBucket({ ...agent, status });
    if (bucket === "running") groups.running.push(agent);
    if (bucket === "attention" && agent.attentionReason === "finished") {
      groups.unreviewed.push(agent);
    }
  }
  groups.running.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  groups.unreviewed.sort((a, b) => {
    const left = a.attentionTimestamp ?? a.lastActivityAt;
    const right = b.attentionTimestamp ?? b.lastActivityAt;
    return right.getTime() - left.getTime();
  });
  return groups;
}
