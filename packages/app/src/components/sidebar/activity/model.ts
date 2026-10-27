import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { ConversationSummary } from "@/screens/session-history/conversation-summary";
import { describeCompletionTimeAgo } from "@/utils/time";
import type { TFunction } from "i18next";

export type SidebarActivityView = "all" | "running" | "unreviewed";

export interface SidebarActivitySessions {
  running: AggregatedAgent[];
  unreviewed: AggregatedAgent[];
}

export function activitySessionTiming(input: { isRunning: boolean; summary: ConversationSummary }) {
  const requestedAt = input.summary.lastRequestAt;
  const respondedAt = input.summary.lastResponseAt;
  let completedAt: number | null = null;
  const responseMatchesRequest =
    requestedAt === null || (respondedAt !== null && respondedAt >= requestedAt);
  if (!input.isRunning && responseMatchesRequest) completedAt = respondedAt;
  return { requestedAt, completedAt };
}

export function describeActivityAge(at: number, now: number, t: TFunction, compact: boolean) {
  const age = describeCompletionTimeAgo(new Date(at), new Date(now));
  if (compact) return age;
  const count = Number.parseInt(age.label, 10);
  const labels = {
    second: "sidebar.activity.agoSeconds",
    minute: "sidebar.activity.agoMinutes",
    hour: "sidebar.activity.agoHours",
    day: "sidebar.activity.agoDays",
  } as const;
  return { ...age, label: t(labels[age.resolution as keyof typeof labels], { count }) };
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
