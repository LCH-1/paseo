import { describe, expect, test } from "vitest";
import { ProviderSubagentStore } from "./store.js";

describe("ProviderSubagentStore", () => {
  test("keeps provider children and their timelines scoped to the parent agent", () => {
    const subagents = new ProviderSubagentStore();

    subagents.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      title: "Explore",
      cwd: "/workspace/child",
      status: "running",
      timestamp: "2026-07-12T10:00:00.000Z",
    });
    subagents.apply("parent-a", "codex", {
      type: "timeline",
      id: "child-1",
      item: { type: "assistant_message", text: "Found it." },
      timestamp: "2026-07-12T10:00:01.000Z",
    });
    subagents.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      status: "completed",
      timestamp: "2026-07-12T10:00:02.000Z",
    });
    subagents.apply("parent-b", "claude", {
      type: "upsert",
      id: "child-1",
      title: "Review",
      status: "running",
      timestamp: "2026-07-12T10:00:03.000Z",
    });

    expect(subagents.list("parent-a")).toEqual([
      expect.objectContaining({
        id: "child-1",
        parentAgentId: "parent-a",
        provider: "codex",
        title: "Explore",
        cwd: "/workspace/child",
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
      }),
    ]);
    expect(subagents.fetchTimeline("parent-a", "child-1").rows).toMatchObject([
      {
        seq: 1,
        timestamp: "2026-07-12T10:00:01.000Z",
        item: { type: "assistant_message", text: "Found it." },
      },
    ]);
    expect(subagents.list("parent-b")[0]).toMatchObject({ provider: "claude", title: "Review" });
    expect(subagents.deleteParent("parent-a")).toEqual([
      { type: "remove", parentAgentId: "parent-a", subagentId: "child-1" },
    ]);
    expect(subagents.list("parent-a")).toEqual([]);
    expect(subagents.list("parent-b")).toHaveLength(1);
  });

  test("limits oversized provider child tool output before storage", () => {
    const subagents = new ProviderSubagentStore();
    const output = "x".repeat(70 * 1024);
    const update = subagents.apply("parent-a", "opencode", {
      type: "timeline",
      id: "child-1",
      item: {
        type: "tool_call",
        callId: "call-1",
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "print", output },
      },
    });

    expect(update?.type).toBe("timeline");
    const [row] = subagents.fetchTimeline("parent-a", "child-1").rows;
    expect(row?.item).toMatchObject({
      type: "tool_call",
      detail: { type: "shell", output: "x".repeat(64 * 1024) },
    });
  });

  test("pages provider history on projected item boundaries", () => {
    const subagents = new ProviderSubagentStore();
    for (let index = 0; index < 101; index += 1) {
      subagents.apply("parent-a", "opencode", {
        type: "timeline",
        id: "child-1",
        item: { type: "assistant_message", text: String(index) },
      });
    }

    const page = subagents.fetchTimeline("parent-a", "child-1", {
      direction: "tail",
      limit: 1,
    });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.seqStart).toBe(1);
    expect(page.rows[0]?.item).toMatchObject({
      text: Array.from({ length: 101 }, (_, i) => String(i)).join(""),
    });
    expect(page.rows.at(-1)?.seq).toBe(101);
    expect(page.hasOlder).toBe(false);
  });

  test("announces an upsert only when it changes what the descriptor says", () => {
    const subagents = new ProviderSubagentStore();
    const declared = subagents.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      title: "Explore",
      description: "Find the bug",
      status: "running",
      toolCallId: "call-1",
      parentSubagentId: null,
      timestamp: "2026-07-12T10:00:00.000Z",
    });

    const repeats = Array.from({ length: 50 }, (_, index) =>
      subagents.apply("parent-a", "codex", {
        type: "upsert",
        id: "child-1",
        title: "Explore",
        description: "Find the bug",
        status: "running",
        toolCallId: "call-1",
        parentSubagentId: null,
        timestamp: `2026-07-12T10:01:${String(index).padStart(2, "0")}.000Z`,
      }),
    );
    const completed = subagents.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      status: "completed",
      timestamp: "2026-07-12T10:02:00.000Z",
    });

    expect(declared).toMatchObject({ type: "upsert", subagent: { status: "running" } });
    expect(repeats).toEqual(Array.from({ length: 50 }, () => null));
    expect(completed).toEqual({
      type: "upsert",
      subagent: {
        id: "child-1",
        parentAgentId: "parent-a",
        parentSubagentId: null,
        provider: "codex",
        title: "Explore",
        description: "Find the bug",
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:02:00.000Z",
        toolCallId: "call-1",
        cwd: null,
        subtitle: null,
      },
    });
  });

  test("an unannounced repeat leaves the stored descriptor as last announced", () => {
    const subagents = new ProviderSubagentStore();
    const declared = subagents.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      title: "Explore",
      status: "running",
      timestamp: "2026-07-12T10:00:00.000Z",
    });

    subagents.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      title: "Explore",
      status: "running",
      timestamp: "2026-07-12T10:05:00.000Z",
    });

    expect(declared).toEqual({ type: "upsert", subagent: subagents.get("parent-a", "child-1") });
  });

  test("a requested timeline stays requested across a replay until its parent is forgotten", () => {
    const subagents = new ProviderSubagentStore();
    subagents.apply("parent-a", "claude", { type: "upsert", id: "child-1", status: "running" });
    subagents.apply("parent-a", "claude", { type: "upsert", id: "child-2", status: "running" });
    subagents.apply("parent-b", "claude", { type: "upsert", id: "child-1", status: "running" });

    subagents.markTimelineRequested("parent-a", "child-1");
    subagents.markTimelineRequested("parent-b", "child-1");
    subagents.deleteParent("parent-a");

    expect({
      opened: subagents.isTimelineRequested("parent-a", "child-1"),
      neverOpened: subagents.isTimelineRequested("parent-a", "child-2"),
    }).toEqual({ opened: true, neverOpened: false });

    subagents.forgetRequestedTimelines("parent-a");

    expect({
      forgotten: subagents.isTimelineRequested("parent-a", "child-1"),
      otherParent: subagents.isTimelineRequested("parent-b", "child-1"),
    }).toEqual({ forgotten: false, otherParent: true });
  });
});
