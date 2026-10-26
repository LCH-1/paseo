import type { SessionState } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { hasActiveMessageSubmission } from "@/composer/submission/model";
import { deriveStreamTurnTiming } from "@/timeline/turn-time";

const EMPTY_ITEMS: StreamItem[] = [];

export function selectAgentTabCompletedAt(
  session:
    | Pick<
        SessionState,
        "agents" | "agentDetails" | "agentStreamTail" | "agentStreamHead" | "messageSubmissions"
      >
    | undefined,
  agentId: string,
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
  if (
    completedAt !== null &&
    agent.lastUserMessageAt &&
    completedAt < agent.lastUserMessageAt.getTime()
  )
    return null;
  return completedAt;
}
