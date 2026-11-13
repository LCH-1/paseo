import { setTimeout as nextTask } from "node:timers/promises";
import { expect, test } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createTimelineFollower, type TimelineEntry } from "./timeline.js";

type Timeline = Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>;
type TimelineMessage = Parameters<Parameters<DaemonClient["subscribeAgentTimeline"]>[1]>[0];

function entry(text: string, timestamp: string, seq: number): TimelineEntry {
  return {
    provider: "codex",
    item: { type: "user_message", text },
    timestamp,
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
    collapsed: [],
  };
}

function timeline(epoch: string, entries: TimelineEntry[]): Timeline {
  return { epoch, entries } as unknown as Timeline;
}

function live(text: string, timestamp: string, epoch: string, seq: number): TimelineMessage {
  return {
    type: "agent_stream",
    payload: {
      agentId: "agent",
      event: { type: "timeline", provider: "codex", item: { type: "user_message", text } },
      timestamp,
      epoch,
      seq,
    },
  };
}

const replacement: TimelineMessage = {
  type: "agent.timeline.replacement",
  payload: { agentId: "agent", epoch: "rebuilt" },
};

/** A daemon whose timeline reads answer only when the test releases them. */
function heldTimelineReads() {
  const releases: Array<(timeline: Timeline) => void> = [];
  const client = {
    fetchAgentTimeline: () =>
      new Promise<Timeline>((resolve) => {
        releases.push(resolve);
      }),
  } as unknown as DaemonClient;
  return {
    client,
    async answer(next: Timeline) {
      const release = releases.shift();
      if (!release) throw new Error("No timeline read is waiting");
      release(next);
      await nextTask(0);
    },
  };
}

function follow(client: DaemonClient, sinceTimestampMs?: number) {
  const printed: string[] = [];
  const text = (item: TimelineEntry["item"]) => (item.type === "user_message" ? item.text : "?");
  const follower = createTimelineFollower({
    client,
    agentId: "agent",
    sinceTimestampMs,
    onMessage: (message) => {
      if (message.type === "agent.timeline.replacement") printed.push("[replaced]");
      else if (message.type === "agent_stream" && message.payload.event.type === "timeline")
        printed.push(text(message.payload.event.item));
    },
    onCatchUp: (entries) => {
      for (const caught of entries) printed.push(text(caught.item));
    },
    onCatchUpError: (error) => {
      printed.push(`[error ${String(error)}]`);
    },
  });
  return { follower, printed };
}

test("a replaced timeline prints only the rows the follow had not seen, in order", async () => {
  const daemon = heldTimelineReads();
  const { follower, printed } = follow(daemon.client);
  const history = follower.readHistory();
  await daemon.answer(
    timeline("first", [
      entry("OLD_USER", "2026-11-13T10:00:00.000Z", 0),
      entry("OLD_REPLY", "2026-11-13T10:00:01.000Z", 1),
    ]),
  );
  expect((await history).map((item) => (item.type === "user_message" ? item.text : "?"))).toEqual([
    "OLD_USER",
    "OLD_REPLY",
  ]);

  follower.receive(live("LIVE", "2026-11-13T10:00:02.000Z", "first", 2));
  follower.receive(replacement);
  // Rows arrive while the rebuilt timeline is read; the first is already in that read.
  follower.receive(live("DURING_READ", "2026-11-13T10:00:04.000Z", "rebuilt", 3));
  follower.receive(live("AFTER_READ", "2026-11-13T10:00:05.000Z", "rebuilt", 4));
  expect(printed).toEqual(["LIVE", "[replaced]"]);

  await daemon.answer(
    timeline("rebuilt", [
      entry("OLD_USER", "2026-11-13T10:00:00.000Z", 0),
      entry("LIVE", "2026-11-13T10:00:02.000Z", 1),
      entry("FROM_ANOTHER_CLIENT", "2026-11-13T10:00:03.000Z", 2),
      entry("DURING_READ", "2026-11-13T10:00:04.000Z", 3),
    ]),
  );

  expect(printed).toEqual([
    "LIVE",
    "[replaced]",
    "FROM_ANOTHER_CLIENT",
    "DURING_READ",
    "AFTER_READ",
  ]);
});

test("a replaced timeline keeps rows before --since out of the catch-up", async () => {
  const daemon = heldTimelineReads();
  const { follower, printed } = follow(daemon.client, Date.parse("2100-01-01T00:00:00.000Z"));
  const history = follower.readHistory();
  await daemon.answer(timeline("first", [entry("OLD", "2026-11-13T10:00:00.000Z", 0)]));
  expect(await history).toEqual([]);

  follower.receive(replacement);
  await daemon.answer(
    timeline("rebuilt", [
      entry("NEW_BEFORE_CUTOFF", "2026-11-13T11:00:00.000Z", 0),
      entry("AFTER_CUTOFF", "2110-01-01T00:00:00.000Z", 1),
    ]),
  );

  expect(printed).toEqual(["[replaced]", "AFTER_CUTOFF"]);
});

test("a replacement that arrives during a catch-up starts another one after it", async () => {
  const daemon = heldTimelineReads();
  const { follower, printed } = follow(daemon.client);
  const history = follower.readHistory();
  await daemon.answer(timeline("first", [entry("OLD", "2026-11-13T10:00:00.000Z", 0)]));
  await history;

  follower.receive(replacement);
  follower.receive(replacement);
  await daemon.answer(
    timeline("second", [
      entry("OLD", "2026-11-13T10:00:00.000Z", 0),
      entry("ADDED", "2026-11-13T10:00:01.000Z", 1),
    ]),
  );
  await daemon.answer(
    timeline("third", [
      entry("OLD", "2026-11-13T10:00:00.000Z", 0),
      entry("ADDED", "2026-11-13T10:00:01.000Z", 1),
      entry("ADDED_AGAIN", "2026-11-13T10:00:02.000Z", 2),
    ]),
  );

  expect(printed).toEqual(["[replaced]", "ADDED", "[replaced]", "ADDED_AGAIN"]);
});
