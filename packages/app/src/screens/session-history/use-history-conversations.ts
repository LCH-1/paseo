import { useMemo, useState } from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import equal from "fast-deep-equal";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { formatHistoryPath, isHistoryAgentWorking } from "./history-presentation";
import {
  EMPTY_CONVERSATION,
  compareHistoryRows,
  fetchConversationSummary,
  mergeConversationSummaries,
  summarizeStream,
  type ConversationSummary,
} from "./conversation-summary";

const RUNNING_CONVERSATION_REFRESH_MS = 30_000;

interface FetchedConversation {
  summary: ConversationSummary;
  /** The lastActivityAt the list knew when this fetch started. */
  activityAt: number;
}

class ConversationFetchError extends Error {
  constructor(
    /** The lastActivityAt the list knew when the failed fetch started. */
    readonly activityAt: number,
    options: { cause: unknown },
  ) {
    super("Conversation summary fetch failed", options);
  }
}

interface FetchedConversationState {
  status: string;
  data: FetchedConversation | undefined;
  error: unknown;
}

const selectSummary = (fetched: FetchedConversation): ConversationSummary => fetched.summary;

function lastAttemptedActivityAt(state: FetchedConversationState): number | undefined {
  if (state.status === "success") return state.data?.activityAt;
  if (state.status === "error" && state.error instanceof ConversationFetchError) {
    return state.error.activityAt;
  }
  return undefined;
}

// A running row is refreshed only while the list knows of activity its last fetch, failed
// or not, has not seen. A quiet or stuck turn is never polled and a failure is not retried
// on its own; new activity after it is. Comparing with "<" rather than "!==" keeps two
// lists that share a query but know different times from refreshing it in turns.
function awaitsRefresh(state: FetchedConversationState, activityAt: number): boolean {
  const attemptedAt = lastAttemptedActivityAt(state);
  return attemptedAt !== undefined && attemptedAt < activityAt;
}

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

type SessionStoreSnapshot = ReturnType<typeof useSessionStore.getState>;

/** What one listed conversation reads from the session store. */
export interface HistoryLiveConversation {
  clientGeneration: number | undefined;
  lastUserMessageAt: number | undefined;
  turnPhase: Agent["turn"]["phase"] | undefined;
  /** The open turn's id; null when the host does not identify its turns. */
  turnId: string | null | undefined;
  isWorking: boolean | undefined;
  workspaceName: string | null | undefined;
  tail: ConversationSummary;
  head: ConversationSummary;
}

export interface HistoryConversationRow {
  agent: AggregatedAgent;
  pathLabel: string;
  isWorking: boolean;
  workspaceName: string;
  summary: ConversationSummary;
  isLoading: boolean;
  isError: boolean;
}

type HistoryConversationQuery = Pick<
  UseQueryResult<ConversationSummary>,
  "data" | "isPending" | "fetchStatus" | "isError"
>;

function selectLiveConversation(
  session: SessionState | undefined,
  agent: AggregatedAgent,
): HistoryLiveConversation {
  const live = session?.agents.get(agent.id) ?? session?.agentDetails.get(agent.id);
  const workspaceId = live?.workspaceId ?? agent.workspaceId;
  const workspace = workspaceId ? session?.workspaces.get(workspaceId) : undefined;
  return {
    clientGeneration: session?.clientGeneration,
    lastUserMessageAt: live?.lastUserMessageAt?.getTime(),
    turnPhase: live?.turn.phase,
    turnId: live?.turn.phase === "open" ? live.turn.turnId : undefined,
    isWorking: live ? isHistoryAgentWorking(live) : undefined,
    workspaceName: workspace?.title ?? workspace?.name,
    tail: summarizeStream(session?.agentStreamTail.get(agent.id)),
    head: summarizeStream(session?.agentStreamHead.get(agent.id)),
  };
}

function readsSameSession(
  before: SessionState | undefined,
  after: SessionState | undefined,
): boolean {
  if (before === after) return true;
  if (!before || !after) return false;
  return (
    before.clientGeneration === after.clientGeneration &&
    before.agents === after.agents &&
    before.agentDetails === after.agentDetails &&
    before.workspaces === after.workspaces &&
    before.agentStreamTail === after.agentStreamTail &&
    before.agentStreamHead === after.agentStreamHead
  );
}

// Session-store selectors run on every store update, including every stream tick of every
// agent on every host. Return the previous entries until a host these agents live on
// replaces something a row reads, and keep each entry whose values did not change so only
// the affected row is rebuilt.
export function createHistoryLiveSelector(
  agents: readonly AggregatedAgent[],
): (state: SessionStoreSnapshot) => readonly HistoryLiveConversation[] {
  const serverIds = [...new Set(agents.map((agent) => agent.serverId))];
  let previousSessions: SessionStoreSnapshot["sessions"] | null = null;
  let previous: readonly HistoryLiveConversation[] | null = null;

  return (state) => {
    const sessions = state.sessions;
    const before = previousSessions;
    previousSessions = sessions;
    if (
      previous &&
      before &&
      (sessions === before ||
        serverIds.every((serverId) => readsSameSession(before[serverId], sessions[serverId])))
    ) {
      return previous;
    }

    const reusable = previous;
    const next = agents.map((agent, index) => {
      const conversation = selectLiveConversation(sessions[agent.serverId], agent);
      const kept = reusable?.[index];
      return kept && equal(kept, conversation) ? kept : conversation;
    });
    if (reusable && next.every((conversation, index) => conversation === reusable[index])) {
      return reusable;
    }
    previous = next;
    return next;
  };
}

function rowKey(agent: AggregatedAgent): string {
  return JSON.stringify([agent.serverId, agent.id]);
}

// Rows cross memo boundaries in both lists. Keep the row object while its values are
// unchanged, and the array while every row and the order are unchanged.
export function createHistoryRowsBuilder(): (
  agents: readonly AggregatedAgent[],
  live: readonly HistoryLiveConversation[],
  queries: readonly HistoryConversationQuery[],
) => HistoryConversationRow[] {
  let previousRows: HistoryConversationRow[] = [];
  let previousByKey = new Map<string, HistoryConversationRow>();

  return (agents, live, queries) => {
    const byKey = new Map<string, HistoryConversationRow>();
    const rows = agents
      .map((agent, index) => {
        const conversation = live[index];
        const query = queries[index];
        const row: HistoryConversationRow = {
          agent,
          pathLabel: formatHistoryPath(agent.cwd),
          isWorking: conversation.isWorking ?? isHistoryAgentWorking(agent),
          workspaceName: conversation.workspaceName ?? agent.projectPlacement?.workspaceName ?? "—",
          summary: mergeConversationSummaries(
            query.data ?? EMPTY_CONVERSATION,
            {
              ...EMPTY_CONVERSATION,
              lastRequestAt:
                conversation.lastUserMessageAt ?? agent.lastUserMessageAt?.getTime() ?? null,
            },
            conversation.tail,
            conversation.head,
          ),
          isLoading: query.isPending && query.fetchStatus !== "idle",
          isError: query.isError,
        };
        const key = rowKey(agent);
        const kept = previousByKey.get(key);
        const reused = kept && equal(kept, row) ? kept : row;
        byKey.set(key, reused);
        return reused;
      })
      .sort(compareHistoryRows);
    previousByKey = byKey;
    if (
      rows.length === previousRows.length &&
      rows.every((row, index) => row === previousRows[index])
    ) {
      return previousRows;
    }
    previousRows = rows;
    return rows;
  };
}

export function useHistoryConversations(agents: AggregatedAgent[]) {
  const selectLive = useMemo(() => createHistoryLiveSelector(agents), [agents]);
  const live = useSessionStore(selectLive);
  const queries = useQueries({
    queries: agents.map((agent, index) => {
      const conversation = live[index];
      const client = getHostRuntimeStore().getClient(agent.serverId);
      const isRunning = conversation.turnPhase === "open";
      const activityAt = agent.lastActivityAt.getTime();
      return {
        queryKey: [
          "historyConversation",
          agent.serverId,
          agent.id,
          conversation.clientGeneration,
          // Every agent_update of a running turn moves lastActivityAt, and a changed key drops
          // the cached summary and fetches the timeline again. A running row keys on its turn
          // and catches up on a timer instead, so a turn that resumes without a new request
          // does not show the previous run's cached summary. The settled time joins the key
          // once the turn ends, so the completion time comes from a fresh fetch.
          isRunning ? (conversation.turnId ?? null) : activityAt,
          conversation.lastUserMessageAt,
          conversation.turnPhase,
        ],
        enabled: !!client,
        staleTime: 30_000,
        refetchInterval: (query: { state: FetchedConversationState }) =>
          isRunning && awaitsRefresh(query.state, activityAt)
            ? RUNNING_CONVERSATION_REFRESH_MS
            : false,
        retry: 1,
        select: selectSummary,
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<FetchedConversation> => {
          try {
            const summary = await withHistorySlot(() =>
              fetchConversationSummary(client!, agent.id, signal),
            );
            return { summary, activityAt };
          } catch (cause) {
            throw new ConversationFetchError(activityAt, { cause });
          }
        },
      };
    }),
  });
  const [buildRows] = useState(createHistoryRowsBuilder);
  const rows = buildRows(agents, live, queries);
  // Only a row without a summary yet counts as loading. A running row refreshing in the
  // background already shows one, and reporting it would flip the history hint each time.
  return { rows, isLoading: queries.some((query) => query.isLoading) };
}
