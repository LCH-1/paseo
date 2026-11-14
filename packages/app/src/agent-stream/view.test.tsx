// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import {
  createTimelineReplica,
  createViewedTimelineOwner,
  type TimelinePageResult,
  type TimelineResponsePayload,
  type ViewedTimelineOwner,
} from "@/timeline/viewed-timeline-sync";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import { HIDDEN_HISTORY_RELEASE_DELAY_MS } from "./presentation-liveness";
import { AgentStreamView } from "./view";

// The rows themselves are out of scope here; each one renders its text so the test can tell
// which rows the view shows.
vi.mock("@/components/message", () => {
  const Row = ({ message }: { message?: string }) =>
    React.createElement("div", { "data-testid": "stream-row" }, message ?? "");
  return {
    MessageOuterSpacingProvider: ({ children }: { children: React.ReactNode }) => children,
    UserMessage: Row,
    AssistantMessage: Row,
    SpeakMessage: Row,
    Notification: Row,
    CompactionMarker: Row,
    TodoListCard: Row,
    ToolCall: Row,
  };
});
vi.mock("@/hooks/use-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-settings")>();
  return {
    ...actual,
    useSettings: (select?: (settings: typeof actual.DEFAULT_APP_SETTINGS) => unknown) =>
      select ? select(actual.DEFAULT_APP_SETTINGS) : { settings: actual.DEFAULT_APP_SETTINGS },
  };
});
// Chat find needs the pane around the chat; it stands aside here as it does on native.
vi.mock("@/agent-stream/chat-find", () => ({
  ChatFind: ({ children }: { children: React.ReactNode }) => children,
  ChatFindExpansion: ({
    children,
  }: {
    children: (renderFullContent: boolean) => React.ReactNode;
  }) => children(false),
  useChatFindSelectedMessageId: () => null,
}));
vi.mock("@/assistant-selection-copy/surface", () => ({
  AssistantSelectionCopySurface: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/plan-card", () => ({ PlanCard: () => null }));
vi.mock("@/components/tool-call-details", () => ({ ToolCallDetailsContent: () => null }));
vi.mock("@/components/tool-call-sheet", () => ({
  ToolCallSheetProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/tool-calls/detail-level/overview/view", () => ({
  OverviewToolCallGroupView: () => null,
}));
vi.mock("./turn-footer", () => ({
  TURN_FOOTER_BOTTOM_SPACING: 0,
  TurnFooter: () => null,
  CompletedTurnFooterRow: () => null,
}));

const SERVER_ID = "stream-view-host";
const AGENT_ID = "agent-1";
const EPOCH = "epoch-1";
const HISTORY_ROWS = 1_200;
const PAGE_ROWS = 40;
const IDLE_TURN = { isActive: false, isCancelling: false, startedAt: null, turnId: null };
const NO_PERMISSIONS = new Map<string, PendingPermission>();
const NO_ITEMS: StreamItem[] = [];
const CONTEXT = { serverId: SERVER_ID, id: AGENT_ID, status: "running" as const, cwd: "/repo" };

let visibilityState: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", {
  configurable: true,
  get: () => visibilityState,
});

function setDocumentVisibility(next: DocumentVisibilityState): void {
  visibilityState = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

function userMessage(id: string, text: string): StreamItem {
  return { kind: "user_message", id, text, timestamp: new Date("2026-11-14T00:00:00.000Z") };
}

function reply(seq: number): StreamItem {
  return {
    kind: "assistant_message",
    id: `reply-${seq}`,
    text: `reply ${seq}`,
    timestamp: new Date("2026-11-14T00:00:00.000Z"),
    timelineCursor: { epoch: EPOCH, seq },
  };
}

/** One long turn: the prompt, then a reply per sequence number up to HISTORY_ROWS. */
function applyLongHistory(): void {
  useSessionStore.getState().applyAgentTimelineResponseState(SERVER_ID, AGENT_ID, {
    items: [
      { ...userMessage("prompt", "prompt"), timelineCursor: { epoch: EPOCH, seq: 1 } },
      ...Array.from({ length: HISTORY_ROWS - 1 }, (_, index) => reply(index + 2)),
    ],
    head: [],
    range: { epoch: EPOCH, startSeq: 1, endSeq: HISTORY_ROWS },
    older: "none",
    newer: false,
    synchronized: true,
    acknowledgedClientMessageIds: [],
  });
}

function latestPage(): TimelineResponsePayload {
  const firstSeq = HISTORY_ROWS - PAGE_ROWS + 1;
  return {
    requestId: "latest-tail",
    agentId: AGENT_ID,
    agent: null,
    direction: "tail",
    projection: "projected",
    reset: false,
    epoch: EPOCH,
    window: { minSeq: 1, maxSeq: HISTORY_ROWS, nextSeq: HISTORY_ROWS + 1 },
    startCursor: { epoch: EPOCH, seq: firstSeq },
    endCursor: { epoch: EPOCH, seq: HISTORY_ROWS },
    entries: Array.from({ length: PAGE_ROWS }, (_, index) => {
      const seq = firstSeq + index;
      return {
        provider: "codex",
        item: { type: "assistant_message", text: `reply ${seq}`, messageId: `reply-${seq}` },
        timestamp: "2026-11-14T00:00:00.000Z",
        seqStart: seq,
        seqEnd: seq,
        sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
        collapsed: [],
      };
    }),
    error: null,
    hasNewer: false,
    hasOlder: true,
    staleCursor: false,
    gap: false,
  };
}

/**
 * The session's timeline owner, with a daemon that answers each latest-tail request when the
 * test says so. Like HostRuntimeStore.fetchAgentTimeline, the page reaches the store before
 * the request settles.
 */
function installTimelineOwner(): { answerTail: () => void; tailRequests: () => number } {
  const pending: (() => void)[] = [];
  let requests = 0;
  let owner!: ViewedTimelineOwner;
  owner = createViewedTimelineOwner({
    serverId: SERVER_ID,
    replica: createTimelineReplica({
      serverId: SERVER_ID,
      storage: { readTimeline: async () => undefined, commitTimeline: () => undefined },
      prepareAgent: async () => undefined,
    }),
    replaceDemandedAgentIds: () => undefined,
    drainQueuedAgentMessage: () => undefined,
    ports: {
      observe: () => ({ ready: Promise.resolve(), release: async () => undefined }),
      readCursor: () => undefined,
      fetchPage: async () => ({ hasNewer: false, endCursor: null }),
      fetchLatestTail: () =>
        new Promise<TimelinePageResult>((resolve) => {
          requests += 1;
          pending.push(() => {
            owner.applyTimelineResponse(latestPage());
            resolve({ hasNewer: false, endCursor: { epoch: EPOCH, seq: HISTORY_ROWS } });
          });
        }),
      reportError: () => undefined,
      schedule: () => () => undefined,
    },
  });
  useSessionStore.getState().setViewedTimelineSync(SERVER_ID, owner);
  return {
    answerTail: () => pending.shift()?.(),
    tailRequests: () => requests,
  };
}

function storedRowCount(): number {
  const timeline = selectAgentTimelineState(
    useSessionStore.getState().sessions[SERVER_ID],
    AGENT_ID,
  );
  return timeline.status === "cold" ? 0 : timeline.items.length;
}

function SessionChat() {
  const items = useSessionStore(
    (state) => state.sessions[SERVER_ID]?.agentStreamTail.get(AGENT_ID) ?? NO_ITEMS,
  );
  return (
    <AgentStreamView
      agentId={AGENT_ID}
      serverId={SERVER_ID}
      context={CONTEXT}
      streamItems={items}
      pendingPermissions={NO_PERMISSIONS}
      turnPresentation={IDLE_TURN}
    />
  );
}

function renderInTab(children: React.ReactNode) {
  const queryClient = new QueryClient();
  const wrap = (content: React.ReactNode, active: boolean) => (
    <QueryClientProvider client={queryClient}>
      <RetainedPanelActivity active={active}>{content}</RetainedPanelActivity>
    </QueryClientProvider>
  );
  const view = render(wrap(children, true));
  return {
    rerender: (content: React.ReactNode, active = true) => view.rerender(wrap(content, active)),
    shownRows: () => view.queryAllByTestId("stream-row").map((row) => row.textContent),
    /** The element a row renders in, which a view mounted again replaces. */
    rowElement: (text: string) =>
      view.queryAllByTestId("stream-row").find((row) => row.textContent === text) ?? null,
  };
}

/** Lets the page, the renders it causes and the settled release run, as they do in the app. */
async function answerOutsideAct(answer: () => void): Promise<void> {
  const global = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = global.IS_REACT_ACT_ENVIRONMENT;
  global.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    answer();
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    global.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  HTMLElement.prototype.scrollTo = () => undefined;
  useSessionStore.getState().initializeSession(SERVER_ID, null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  act(() => setDocumentVisibility("visible"));
  useSessionStore.getState().clearSession(SERVER_ID);
});

describe("AgentStreamView releasing a long hidden history", () => {
  it("lets a hidden chat at the live edge drop its rows for the daemon's latest page", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    applyLongHistory();
    const daemon = installTimelineOwner();
    const view = renderInTab(<SessionChat />);
    expect(view.shownRows()).toContain("reply 1100");
    const latestRowBefore = view.rowElement("reply 1200");
    expect(latestRowBefore).not.toBeNull();

    act(() => setDocumentVisibility("hidden"));
    act(() => vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS));
    expect(daemon.tailRequests()).toBe(1);
    await answerOutsideAct(daemon.answerTail);

    expect(storedRowCount()).toBe(PAGE_ROWS);
    expect(visibilityState).toBe("hidden");
    expect(view.shownRows()).not.toContain("reply 1100");
    expect(view.shownRows()).toContain("reply 1200");
    expect(view.shownRows().length).toBeLessThanOrEqual(PAGE_ROWS);
    // Mounted again: nothing the view built while it held the old rows is left to keep them.
    expect(view.rowElement("reply 1200")).not.toBe(latestRowBefore);

    act(() => setDocumentVisibility("visible"));
    expect(view.shownRows()).toContain("reply 1200");
    expect(view.shownRows()).not.toContain("reply 1100");
  });

  it("lets a chat in a tab left for longer than the delay drop its rows and shows the latest page when the tab is back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    applyLongHistory();
    const daemon = installTimelineOwner();
    const view = renderInTab(<SessionChat />);

    view.rerender(<SessionChat />, false);
    act(() => vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS));
    expect(daemon.tailRequests()).toBe(1);
    await answerOutsideAct(daemon.answerTail);
    expect(storedRowCount()).toBe(PAGE_ROWS);

    view.rerender(<SessionChat />, true);
    expect(view.shownRows()).toContain("reply 1200");
    expect(view.shownRows()).not.toContain("reply 1100");
  });

  it("keeps every row of a chat shown again within the release delay", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    applyLongHistory();
    const daemon = installTimelineOwner();
    const view = renderInTab(<SessionChat />);

    act(() => setDocumentVisibility("hidden"));
    act(() => vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS - 1));
    act(() => setDocumentVisibility("visible"));
    act(() => vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS));

    expect(daemon.tailRequests()).toBe(0);
    expect(storedRowCount()).toBe(HISTORY_ROWS);
    expect(view.shownRows()).toContain("reply 1100");
  });

  it("keeps every row of a chat shown again while the latest page is on its way", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    applyLongHistory();
    const daemon = installTimelineOwner();
    const view = renderInTab(<SessionChat />);
    const latestRowBefore = view.rowElement("reply 1200");
    expect(latestRowBefore).not.toBeNull();

    act(() => setDocumentVisibility("hidden"));
    act(() => vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS));
    expect(daemon.tailRequests()).toBe(1);
    act(() => setDocumentVisibility("visible"));
    await answerOutsideAct(daemon.answerTail);

    expect(storedRowCount()).toBe(HISTORY_ROWS);
    expect(view.shownRows()).toContain("reply 1100");
    expect(view.rowElement("reply 1200")).toBe(latestRowBefore);
  });
});
