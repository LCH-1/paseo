import { describe, expect, it, vi } from "vitest";
import { selectAgentTabCompletedAt, fetchAgentTabCompletedAt } from "./agent-tab-completion";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { projectAgentSnapshot } from "@/utils/agent-snapshots";
import type { Agent } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { describeCompletionTimeAgo } from "@/utils/time";

const start = new Date("2026-10-26T00:00:00Z");
const end = new Date("2026-10-26T00:00:10Z");
function fixture(): NonNullable<Parameters<typeof selectAgentTabCompletedAt>[0]> {
  const agent: Agent = {
    id: "a",
    serverId: "host",
    provider: "codex",
    createdAt: start,
    updatedAt: end,
    lastActivityAt: end,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    persistence: null,
    title: "original",
    cwd: "/repo",
    model: null,
    parentAgentId: null,
    labels: {},
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    pendingPermissions: [],
    lastUserMessageAt: start,
    attentionReason: null,
  };
  return {
    agents: new Map([["a", agent]]),
    agentDetails: new Map(),
    messageSubmissions: new Map(),
    agentStreamTail: new Map([
      [
        "a",
        [
          { kind: "user_message", id: "u", text: "request", timestamp: start },
          { kind: "assistant_message", id: "r", text: "response", timestamp: end },
        ] as StreamItem[],
      ],
    ]),
    agentStreamHead: new Map(),
  };
}
describe("agent tab completion", () => {
  it("hydrates a restored tab once from a bounded tail and keeps the time after reading", async () => {
    const session = fixture();
    session.agentStreamTail.clear();
    const page: Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>> = {
      requestId: "q",
      agentId: "a",
      agent: projectAgentSnapshot(session.agents.get("a")!),
      direction: "tail",
      projection: "canonical",
      epoch: "e",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      startCursor: null,
      endCursor: null,
      hasOlder: false,
      hasNewer: false,
      error: null,
      entries: [
        {
          provider: "codex",
          item: { type: "assistant_message", text: "done" },
          timestamp: end.toISOString(),
          seqStart: 2,
          seqEnd: 2,
          sourceSeqRanges: [],
          collapsed: [],
        },
      ],
    };
    const fetchAgentTimeline = vi.fn<DaemonClient["fetchAgentTimeline"]>().mockResolvedValue(page);
    const client = { fetchAgentTimeline };
    const [first, second] = await Promise.all([
      fetchAgentTabCompletedAt(client, "a", start.getTime(), 1),
      fetchAgentTabCompletedAt(client, "a", start.getTime(), 1),
    ]);
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(1);
    expect(fetchAgentTimeline).toHaveBeenCalledWith("a", {
      direction: "tail",
      limit: 10,
      projection: "canonical",
      mergeWindow: true,
    });
    expect(first).toBe(second);
    expect(selectAgentTabCompletedAt(session, "a", first)).toBe(end.getTime());
    session.agents.get("a")!.lastUserMessageAt = new Date(end.getTime() + 1);
    expect(selectAgentTabCompletedAt(session, "a", first)).toBeNull();
    const changed = await fetchAgentTabCompletedAt(client, "a", end.getTime() + 1, 1);
    expect(changed.completedAt).toBeNull();
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);
    await fetchAgentTabCompletedAt(client, "a", start.getTime(), 2);
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(3);
  });
  it("formats seconds, minutes, hours, days and future clock skew", () => {
    for (const [age, label] of [
      [-5000, "0s"],
      [5000, "5s"],
      [59999, "59s"],
      [60000, "1m"],
      [25 * 60000, "25m"],
      [3600000, "1h"],
      [86400000, "1d"],
    ] as const) {
      expect(describeCompletionTimeAgo(start, new Date(start.getTime() + age)).label).toBe(label);
    }
  });
  it("uses the same completed response time after read, title edits and reconnect hydration", () => {
    const session = fixture();
    expect(selectAgentTabCompletedAt(session, "a")).toBe(end.getTime());
    session.agents.get("a")!.updatedAt = new Date("2026-10-26T01:00:00Z");
    session.agents.get("a")!.title = "renamed";
    expect(selectAgentTabCompletedAt(session, "a")).toBe(end.getTime());
  });
  it("hides old completion during a new run, pending send, permission, or error", () => {
    for (const patch of [
      { status: "running" },
      { status: "error" },
      { attentionReason: "permission" },
      { pendingPermissions: [{}] },
      { turn: { phase: "open", turnId: "next", startedAt: end } },
    ]) {
      const session = fixture();
      Object.assign(session.agents.get("a")!, patch);
      expect(selectAgentTabCompletedAt(session, "a")).toBeNull();
    }
    const session = fixture();
    session.messageSubmissions.set("a", [
      { clientMessageId: "next", providerAcknowledged: false, rpcSettled: false },
    ]);
    expect(selectAgentTabCompletedAt(session, "a")).toBeNull();
  });
  it("does not invent completion for missing history, another host, or a newer unanswered prompt", () => {
    expect(selectAgentTabCompletedAt(undefined, "a")).toBeNull();
    const session = fixture();
    session.agentStreamTail.clear();
    expect(selectAgentTabCompletedAt(session, "a")).toBeNull();
    session.agentStreamTail = fixture().agentStreamTail;
    session.agents.get("a")!.lastUserMessageAt = new Date(end.getTime() + 1000);
    expect(selectAgentTabCompletedAt(session, "a")).toBeNull();
    expect(selectAgentTabCompletedAt(fixture(), "other")).toBeNull();
  });
  it("uses the latest completed response after the next task finishes", () => {
    const session = fixture(),
      next = new Date(end.getTime() + 60_000);
    session.agentStreamHead.set("a", [
      { kind: "user_message", id: "u2", text: "next", timestamp: new Date(end.getTime() + 1) },
      { kind: "assistant_message", id: "r2", text: "done", timestamp: next },
    ]);
    expect(selectAgentTabCompletedAt(session, "a")).toBe(next.getTime());
  });
});
