import { useEffect, useState } from "react";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { StreamItem } from "@/types/stream";
import { hasActiveMessageSubmission } from "@/composer/submission/model";
import { deriveStreamTurnTiming } from "@/timeline/turn-time";

const EMPTY_ITEMS: StreamItem[] = [];
interface HistoryCompletion {
  lastUserAt: number | null;
  completedAt: number | null;
}
type TimelineClient = Pick<DaemonClient, "fetchAgentTimeline">;
const historyRequests = new WeakMap<TimelineClient, Map<string, Promise<HistoryCompletion>>>();

export function fetchAgentTabCompletedAt(
  client: TimelineClient,
  agentId: string,
  lastUserAt: number | null,
  generation: number,
): Promise<HistoryCompletion> {
  let requests = historyRequests.get(client);
  if (!requests) {
    requests = new Map();
    historyRequests.set(client, requests);
  }
  const key = JSON.stringify([agentId, lastUserAt, generation]);
  const previous = requests.get(key);
  if (previous) return previous;
  const request = client
    .fetchAgentTimeline(agentId, {
      direction: "tail",
      limit: 10,
      projection: "canonical",
      mergeWindow: true,
    })
    .then((page) => {
      const snapshot = page.agent;
      const result: HistoryCompletion = { lastUserAt, completedAt: null };
      if (
        !snapshot ||
        (snapshot.status !== "idle" && snapshot.status !== "closed") ||
        snapshot.activeTurn ||
        (snapshot.lastUserMessageAt ? Date.parse(snapshot.lastUserMessageAt) : null) !== lastUserAt
      )
        return result;
      let hasResponse = false;
      for (const entry of page.entries) {
        if (entry.item.type === "user_message") hasResponse = false;
        if (entry.item.type === "assistant_message") hasResponse = true;
        result.completedAt = Date.parse(entry.timestamp);
      }
      if (
        !hasResponse ||
        (result.completedAt !== null && lastUserAt !== null && result.completedAt < lastUserAt)
      )
        result.completedAt = null;
      return result;
    })
    .catch(() => {
      console.warn("[agent-tab-completion] Recent response lookup failed");
      return { lastUserAt, completedAt: null };
    });
  requests.set(key, request);
  return request;
}

export function useAgentTabCompletedAt(serverId: string, agentId: string | null): number | null {
  const [history, setHistory] = useState<{ key: string; value: HistoryCompletion } | null>(null);
  const historyKey = JSON.stringify([serverId, agentId]);
  const completedAt = useSessionStore((state) =>
    agentId
      ? selectAgentTabCompletedAt(
          state.sessions[serverId],
          agentId,
          history?.key === historyKey ? history.value : null,
        )
      : null,
  );
  const agent = useSessionStore((state) =>
    agentId
      ? (state.sessions[serverId]?.agents.get(agentId) ??
        state.sessions[serverId]?.agentDetails.get(agentId))
      : undefined,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client);
  const generation = useSessionStore((state) => state.sessions[serverId]?.clientGeneration ?? 0);
  const lastUserAt = agent?.lastUserMessageAt?.getTime() ?? null;
  const pendingSubmission = useSessionStore((state) =>
    agentId
      ? hasActiveMessageSubmission(state.sessions[serverId]?.messageSubmissions.get(agentId))
      : false,
  );
  const eligible =
    !!agent &&
    (agent.status === "idle" || agent.status === "closed") &&
    agent.turn.phase === "idle" &&
    agent.pendingPermissions.length === 0 &&
    agent.attentionReason !== "error" &&
    agent.attentionReason !== "permission" &&
    !pendingSubmission;
  useEffect(() => {
    if (!agentId || !client || completedAt !== null || !eligible) return;
    let cancelled = false;
    void fetchAgentTabCompletedAt(client, agentId, lastUserAt, generation).then((value) => {
      if (!cancelled) setHistory({ key: historyKey, value });
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, client, completedAt, eligible, generation, historyKey, lastUserAt]);
  return completedAt;
}

export function selectAgentTabCompletedAt(
  session:
    | Pick<
        SessionState,
        "agents" | "agentDetails" | "agentStreamTail" | "agentStreamHead" | "messageSubmissions"
      >
    | undefined,
  agentId: string,
  history: HistoryCompletion | null = null,
): number | null {
  const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
  if (
    !agent ||
    !session ||
    (agent.status !== "idle" && agent.status !== "closed") ||
    agent.turn.phase !== "idle" ||
    agent.pendingPermissions.length > 0 ||
    agent.attentionReason === "error" ||
    agent.attentionReason === "permission" ||
    hasActiveMessageSubmission(session.messageSubmissions.get(agentId))
  )
    return null;
  const timings = deriveStreamTurnTiming({
    isTurnActive: false,
    activeTurnStartedAt: null,
    tail: session.agentStreamTail.get(agentId) ?? EMPTY_ITEMS,
    head: session.agentStreamHead.get(agentId) ?? EMPTY_ITEMS,
  });
  let completedAt: number | null = null;
  for (const timing of timings.byAssistantId.values()) {
    const time = timing.completedAt.getTime();
    if (completedAt === null || time > completedAt) completedAt = time;
  }
  if (completedAt === null && history?.lastUserAt === (agent.lastUserMessageAt?.getTime() ?? null))
    completedAt = history?.completedAt ?? null;
  if (
    completedAt !== null &&
    agent.lastUserMessageAt &&
    completedAt < agent.lastUserMessageAt.getTime()
  )
    return null;
  return completedAt;
}
