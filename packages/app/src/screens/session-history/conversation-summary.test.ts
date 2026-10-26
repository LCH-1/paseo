import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  EMPTY_CONVERSATION,
  compareLastResponse,
  compareHistoryRows,
  fetchConversationSummary,
  mergeConversationSummaries,
  summarizeStream,
} from "./conversation-summary";

const request = "2026-10-26T00:00:00Z";
const response = "2026-10-26T00:01:00Z";
const nextRequest = "2026-10-26T00:02:00Z";
function page(entries: { type: string; text?: string; at: string }[], hasOlder = false, seq = 10) {
  return {
    agent: { lastUserMessageAt: nextRequest },
    entries: entries.map(({ type, text, at }) => ({ item: { type, text }, timestamp: at })),
    hasOlder,
    startCursor: { epoch: "e", seq },
  };
}
function client(...pages: ReturnType<typeof page>[]) {
  const fetchAgentTimeline = vi.fn();
  for (const value of pages) fetchAgentTimeline.mockResolvedValueOnce(value);
  return { fetchAgentTimeline } as unknown as Pick<DaemonClient, "fetchAgentTimeline">;
}

describe("history conversation metadata", () => {
  it("puts running tasks first by request time, then finished tasks by response time", () => {
    const row = (
      id: string,
      working: boolean,
      requestAt: number | null,
      responseAt: number | null,
    ) => ({
      agent: { id, serverId: "h" },
      isWorking: working,
      summary: { ...EMPTY_CONVERSATION, lastRequestAt: requestAt, lastResponseAt: responseAt },
    });
    const runningOld = row("running-old", true, 10, 99);
    const runningNew = row("running-new", true, 20, 5);
    const completedNew = row("done-new", false, 40, 100);
    const completedOld = row("done-old", false, 80, 50);
    const unknown = row("no-response", false, 200, null);
    expect(
      [completedOld, unknown, runningOld, completedNew, runningNew]
        .sort(compareHistoryRows)
        .map((r) => r.agent.id),
    ).toEqual(["running-new", "running-old", "done-new", "done-old", "no-response"]);
    expect(
      [{ ...runningNew, isWorking: false }, completedNew, runningOld]
        .sort(compareHistoryRows)
        .map((r) => r.agent.id),
    ).toEqual(["running-old", "done-new", "running-new"]);
  });
  it("separates the last request and response while showing the latest conversation excerpt", async () => {
    const c = client(
      page([
        { type: "assistant_message", text: "previous response", at: response },
        { type: "user_message", text: "new\n request", at: nextRequest },
        { type: "tool_call", text: "must never show tools", at: "2026-10-26T00:03:00Z" },
      ]),
    );
    expect(await fetchConversationSummary(c, "a")).toEqual({
      lastRequestAt: Date.parse(nextRequest),
      lastResponseAt: Date.parse(response),
      previewAt: Date.parse(nextRequest),
      preview: "new request",
    });
    expect(c.fetchAgentTimeline).toHaveBeenCalledTimes(1);
  });
  it("pages past long tool sequences until it finds the actual last response", async () => {
    const c = client(
      page([{ type: "tool_call", at: nextRequest }], true, 40),
      page(
        [
          { type: "user_message", text: "first", at: request },
          { type: "assistant_message", text: "answer", at: response },
        ],
        true,
        8,
      ),
    );
    expect((await fetchConversationSummary(c, "a")).lastResponseAt).toBe(Date.parse(response));
    expect(c.fetchAgentTimeline).toHaveBeenNthCalledWith(
      2,
      "a",
      expect.objectContaining({ direction: "before", cursor: { epoch: "e", seq: 40 } }),
    );
  });
  it("does not manufacture a response timestamp for a request-only conversation", async () => {
    expect(
      (
        await fetchConversationSummary(
          client(page([{ type: "user_message", text: "request", at: request }])),
          "a",
        )
      ).lastResponseAt,
    ).toBeNull();
  });
  it("merges newer live messages and bounds previews without replacing valid older response metadata", () => {
    const old = { ...EMPTY_CONVERSATION, lastResponseAt: Date.parse(response) };
    const live = summarizeStream([
      { kind: "user_message", id: "u", timestamp: new Date(nextRequest), text: "가".repeat(500) },
    ]);
    const result = mergeConversationSummaries(old, live);
    expect(result.lastResponseAt).toBe(Date.parse(response));
    expect(result.lastRequestAt).toBe(Date.parse(nextRequest));
    expect(result.preview).toHaveLength(240);
  });
  it("sorts by actual response time and leaves conversations without responses last", () => {
    const rows = [null, Date.parse(response), Date.parse(request)].map((at, index) => ({
      agent: { serverId: "h", id: String(index) },
      summary: { ...EMPTY_CONVERSATION, lastResponseAt: at },
    }));
    expect(rows.sort(compareLastResponse).map((row) => row.agent.id)).toEqual(["1", "2", "0"]);
  });
  it("stops paging if a server repeats its cursor", async () => {
    await expect(
      fetchConversationSummary(client(page([], true), page([], true)), "a"),
    ).rejects.toThrow("cursor did not advance");
  });
  it("does not issue a queued lookup after leaving the screen", async () => {
    const controller = new AbortController();
    controller.abort();
    const c = client();
    await expect(fetchConversationSummary(c, "a", controller.signal)).rejects.toThrow("cancelled");
    expect(c.fetchAgentTimeline).not.toHaveBeenCalled();
  });
});
