import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export const LIVE_HISTORY_FETCH_TIMEOUT_MS = 2_000;

type TimelineMessage = Parameters<Parameters<DaemonClient["subscribeAgentTimeline"]>[1]>[0];
type ProjectedTimeline = Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>;
export type TimelineEntry = ProjectedTimeline["entries"][number];

interface FetchProjectedTimelineItemsInput {
  client: DaemonClient;
  agentId: string;
  timeoutMs?: number;
  sinceTimestampMs?: number;
}

function fetchProjectedTimeline(
  client: DaemonClient,
  agentId: string,
  timeoutMs: number | undefined,
): Promise<ProjectedTimeline> {
  return client.fetchAgentTimeline(agentId, {
    direction: "tail",
    limit: 0,
    projection: "projected",
    timeout: timeoutMs,
  });
}

function entriesSince(
  entries: TimelineEntry[],
  sinceTimestampMs: number | undefined,
): TimelineEntry[] {
  if (sinceTimestampMs === undefined) return entries;
  return entries.filter((entry) => Date.parse(entry.timestamp) >= sinceTimestampMs);
}

export async function fetchProjectedTimelineItems(
  input: FetchProjectedTimelineItemsInput,
): Promise<AgentTimelineItem[]> {
  const timeline = await fetchProjectedTimeline(input.client, input.agentId, input.timeoutMs);
  return entriesSince(timeline.entries, input.sinceTimestampMs).map((entry) => entry.item);
}

interface TimelineFollowerInput {
  client: DaemonClient;
  agentId: string;
  sinceTimestampMs?: number;
  /** Every subscription message in order, replacements included, minus rows a catch-up printed. */
  onMessage: (message: TimelineMessage) => void;
  /** The rows of a replaced timeline newer than any the follower had seen. */
  onCatchUp: (entries: TimelineEntry[]) => void;
  onCatchUpError: (error: unknown) => void;
}

export interface TimelineFollower {
  /** The timeline as it stands, since `sinceTimestampMs`. Later catch-ups print only newer rows. */
  readHistory(timeoutMs?: number): Promise<AgentTimelineItem[]>;
  /** The subscription handler. */
  receive(message: TimelineMessage): void;
}

/**
 * A daemon announces a rebuilt timeline (rewind, refresh) with one replacement message instead
 * of streaming the rebuilt rows. A terminal cannot redraw what it printed, so the follower reads
 * the timeline again and passes on only rows newer than any it saw: what another client added,
 * not the history already on screen. Messages that arrive during the read wait so output keeps
 * its order, and those carrying rows the read returned are dropped.
 */
export function createTimelineFollower(input: TimelineFollowerInput): TimelineFollower {
  let seenThroughMs: number | undefined;
  let lastRead: { epoch: string; seq: number } | null = null;
  let waiting: TimelineMessage[] | null = null;

  const see = (timestamp: string) => {
    const ms = Date.parse(timestamp);
    if (Number.isNaN(ms)) return;
    if (seenThroughMs === undefined || ms > seenThroughMs) seenThroughMs = ms;
  };

  const catchUp = async () => {
    waiting = [];
    try {
      const timeline = await fetchProjectedTimeline(input.client, input.agentId, undefined);
      const floor = seenThroughMs;
      const unseen = entriesSince(timeline.entries, input.sinceTimestampMs).filter(
        (entry) => floor === undefined || Date.parse(entry.timestamp) > floor,
      );
      let seq = -1;
      for (const entry of timeline.entries) {
        see(entry.timestamp);
        seq = Math.max(seq, entry.seqEnd);
      }
      lastRead = { epoch: timeline.epoch, seq };
      input.onCatchUp(unseen);
    } catch (error) {
      input.onCatchUpError(error);
    } finally {
      const pending = waiting ?? [];
      waiting = null;
      // A replacement among them starts another read, and the rest wait for it.
      for (const message of pending) receive(message);
    }
  };

  const receive = (message: TimelineMessage): void => {
    if (waiting) {
      waiting.push(message);
      return;
    }
    if (message.type === "agent.timeline.replacement") {
      input.onMessage(message);
      void catchUp();
      return;
    }
    if (message.type === "agent_stream" && message.payload.event.type === "timeline") {
      const { epoch, seq, timestamp } = message.payload;
      if (lastRead && epoch === lastRead.epoch && seq !== undefined && seq <= lastRead.seq) return;
      see(timestamp);
    }
    input.onMessage(message);
  };

  return {
    async readHistory(timeoutMs) {
      const timeline = await fetchProjectedTimeline(input.client, input.agentId, timeoutMs);
      for (const entry of timeline.entries) see(entry.timestamp);
      return entriesSince(timeline.entries, input.sinceTimestampMs).map((entry) => entry.item);
    },
    receive,
  };
}
