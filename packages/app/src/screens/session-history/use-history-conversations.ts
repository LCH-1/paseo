import { useQueries } from "@tanstack/react-query";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  EMPTY_CONVERSATION,
  compareLastResponse,
  fetchConversationSummary,
  mergeConversationSummaries,
  summarizeStream,
} from "./conversation-summary";

let activeRequests = 0;
const waiting: (() => void)[] = [];
async function withHistorySlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeRequests >= 4) await new Promise<void>((resolve) => waiting.push(resolve));
  else activeRequests++;
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else activeRequests--;
  }
}

export function useHistoryConversations(agents: AggregatedAgent[]) {
  const sessions = useSessionStore((state) => state.sessions);
  const queries = useQueries({
    queries: agents.map((agent) => {
      const session = sessions[agent.serverId];
      const live = session?.agents.get(agent.id) ?? session?.agentDetails.get(agent.id);
      const client = getHostRuntimeStore().getClient(agent.serverId);
      return {
        queryKey: [
          "historyConversation",
          agent.serverId,
          agent.id,
          session?.clientGeneration,
          agent.lastActivityAt.getTime(),
          live?.lastUserMessageAt?.getTime(),
          live?.turn.phase,
        ],
        enabled: !!client,
        staleTime: 30_000,
        retry: 1,
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          withHistorySlot(() => fetchConversationSummary(client!, agent.id, signal)),
      };
    }),
  });
  const rows = agents
    .map((agent, index) => {
      const session = sessions[agent.serverId];
      const live = session?.agents.get(agent.id) ?? session?.agentDetails.get(agent.id);
      const workspaceId = live?.workspaceId ?? agent.workspaceId;
      const workspace = workspaceId ? session?.workspaces.get(workspaceId) : undefined;
      return {
        agent,
        workspaceName:
          workspace?.title ?? workspace?.name ?? agent.projectPlacement?.workspaceName ?? "—",
        summary: mergeConversationSummaries(
          queries[index].data ?? EMPTY_CONVERSATION,
          {
            ...EMPTY_CONVERSATION,
            lastRequestAt: (live?.lastUserMessageAt ?? agent.lastUserMessageAt)?.getTime() ?? null,
          },
          summarizeStream(session?.agentStreamTail.get(agent.id)),
          summarizeStream(session?.agentStreamHead.get(agent.id)),
        ),
        isLoading: queries[index].isPending && queries[index].fetchStatus !== "idle",
        isError: queries[index].isError,
      };
    })
    .sort(compareLastResponse);
  return { rows, isLoading: queries.some((query) => query.isFetching) };
}
