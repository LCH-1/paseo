import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { StreamItem } from "@/types/stream";

export interface ConversationSummary {
  lastRequestAt: number | null;
  lastResponseAt: number | null;
  previewAt: number | null;
  preview: string;
}

export const EMPTY_CONVERSATION: ConversationSummary = {
  lastRequestAt: null,
  lastResponseAt: null,
  previewAt: null,
  preview: "",
};

export function mergeConversationSummaries(
  ...summaries: ConversationSummary[]
): ConversationSummary {
  const result = { ...EMPTY_CONVERSATION };
  for (const summary of summaries) {
    if (
      summary.lastRequestAt !== null &&
      (result.lastRequestAt === null || summary.lastRequestAt > result.lastRequestAt)
    )
      result.lastRequestAt = summary.lastRequestAt;
    if (
      summary.lastResponseAt !== null &&
      (result.lastResponseAt === null || summary.lastResponseAt > result.lastResponseAt)
    )
      result.lastResponseAt = summary.lastResponseAt;
    if (
      summary.previewAt !== null &&
      (result.previewAt === null || summary.previewAt >= result.previewAt)
    ) {
      result.previewAt = summary.previewAt;
      result.preview = summary.preview;
    }
  }
  return result;
}

function messageSummary(kind: string, timestamp: number, text: string): ConversationSummary {
  if (!Number.isFinite(timestamp) || (kind !== "user_message" && kind !== "assistant_message"))
    return EMPTY_CONVERSATION;
  return {
    lastRequestAt: kind === "user_message" ? timestamp : null,
    lastResponseAt: kind === "assistant_message" ? timestamp : null,
    previewAt: timestamp,
    preview: text.replace(/\s+/g, " ").trim().slice(0, 240),
  };
}

const streamSummaries = new WeakMap<readonly StreamItem[], ConversationSummary>();
export function summarizeStream(items: readonly StreamItem[] | undefined): ConversationSummary {
  if (!items) return EMPTY_CONVERSATION;
  const cached = streamSummaries.get(items);
  if (cached) return cached;
  let result = EMPTY_CONVERSATION;
  for (const item of items) {
    if (item.kind === "user_message" || item.kind === "assistant_message")
      result = mergeConversationSummaries(
        result,
        messageSummary(item.kind, item.timestamp.getTime(), item.text),
      );
  }
  streamSummaries.set(items, result);
  return result;
}

export async function fetchConversationSummary(
  client: Pick<DaemonClient, "fetchAgentTimeline">,
  agentId: string,
  signal?: AbortSignal,
): Promise<ConversationSummary> {
  let result = EMPTY_CONVERSATION;
  let cursor: { epoch: string; seq: number } | undefined;
  const visited = new Set<string>();
  while (!signal?.aborted) {
    const page = await client.fetchAgentTimeline(agentId, {
      direction: cursor ? "before" : "tail",
      ...(cursor ? { cursor } : {}),
      limit: 32,
      projection: "canonical",
      mergeWindow: true,
    });
    if (page.agent?.lastUserMessageAt)
      result = mergeConversationSummaries(result, {
        ...EMPTY_CONVERSATION,
        lastRequestAt: Date.parse(page.agent.lastUserMessageAt),
      });
    for (const entry of page.entries) {
      if (entry.item.type === "user_message" || entry.item.type === "assistant_message")
        result = mergeConversationSummaries(
          result,
          messageSummary(entry.item.type, Date.parse(entry.timestamp), entry.item.text),
        );
    }
    if (result.lastResponseAt !== null || !page.hasOlder || !page.startCursor) return result;
    const key = JSON.stringify(page.startCursor);
    if (visited.has(key)) throw new Error("History timeline cursor did not advance");
    visited.add(key);
    cursor = page.startCursor;
  }
  throw new Error("History conversation lookup cancelled");
}

export function compareLastResponse(
  a: { summary: ConversationSummary; agent: { serverId: string; id: string } },
  b: { summary: ConversationSummary; agent: { serverId: string; id: string } },
): number {
  return (
    (b.summary.lastResponseAt ?? -Infinity) - (a.summary.lastResponseAt ?? -Infinity) ||
    JSON.stringify([a.agent.serverId, a.agent.id]).localeCompare(
      JSON.stringify([b.agent.serverId, b.agent.id]),
    )
  );
}
