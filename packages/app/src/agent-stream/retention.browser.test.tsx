import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RetainedPanel } from "@/components/retained-panel";
import { RetainedChatContent } from "@/panels/retained-chat-content.web";
import type { StreamItem } from "@/types/stream";
import type { StreamRenderInput, StreamViewportHandle } from "./strategy";
import { createWebStreamStrategy } from "./strategy-web";

vi.mock("@/agent-stream/chat-find", () => ({
  useChatFindSelectedMessageId: () => null,
}));
vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => null }));
vi.mock("@/components/ui/overlay-scrollbar/dom-overlay-scrollbar", () => ({
  DomOverlayScrollbar: () => null,
}));

const history: StreamItem[] = Array.from({ length: 200 }, (_, index) => ({
  kind: "user_message",
  id: `message-${index}`,
  text: `Message ${index}`,
  timestamp: new Date("2026-11-02T00:00:00.000Z"),
}));
const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
const rowStyle = { height: 48 };
const renderRow = (item: StreamItem) => <div style={rowStyle}>{item.id}</div>;
const input: StreamRenderInput = {
  agentId: "retained-agent",
  segments: { historyVirtualized: history, historyMounted: [], liveHead: [] },
  boundary: { hasVirtualizedHistory: true, hasMountedHistory: false, hasLiveHead: false },
  renderers: {
    renderHistoryVirtualizedRow: renderRow,
    renderHistoryMountedRow: renderRow,
    renderLiveHeadRow: renderRow,
    renderLiveAuxiliary: () => null,
  },
  listEmptyComponent: null,
  viewportRef: React.createRef<StreamViewportHandle>(),
  routeBottomAnchorRequest: null,
  isAuthoritativeHistoryReady: true,
  onNearBottomChange: () => undefined,
  onNearHistoryStart: () => false,
  isLoadingOlderHistory: false,
  hasOlderHistory: false,
  olderHistoryProgressKey: null,
  scrollEnabled: true,
  listStyle: null,
  baseListContentContainerStyle: null,
  forwardListContentContainerStyle: null,
  contentMaxWidth: 800,
};
const newMessage: StreamItem = {
  kind: "user_message",
  id: "new-message",
  text: "Arrived while hidden",
  timestamp: new Date("2026-11-02T00:00:01.000Z"),
};
const updatedInput: StreamRenderInput = {
  ...input,
  segments: { ...input.segments, historyMounted: [newMessage] },
  boundary: { ...input.boundary, hasMountedHistory: true },
};
const newRouteInput: StreamRenderInput = {
  ...updatedInput,
  routeBottomAnchorRequest: {
    agentId: input.agentId,
    reason: "initial-entry",
    requestKey: "new-route-activation",
  },
};

function Chat({
  active,
  renderInput = input,
}: {
  active: boolean;
  renderInput?: StreamRenderInput;
}) {
  return (
    <RetainedPanel active={active}>
      <RetainedChatContent>{strategy.render(renderInput)}</RetainedChatContent>
    </RetainedPanel>
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

it("keeps virtual history mounted through hidden geometry and the first returned frames", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:800px;height:500px";
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<Chat active />));
    const viewport = host.querySelector('[data-testid="agent-chat-scroll"]');
    if (!(viewport instanceof HTMLElement)) throw Error("Chat viewport did not mount");
    await vi.waitFor(() =>
      expect(viewport.querySelectorAll("[data-history-row-id]").length).toBeGreaterThan(0),
    );
    flushSync(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      viewport.scrollTop = 5000;
      viewport.dispatchEvent(new Event("scroll"));
    });
    for (let frame = 0; frame < 3; frame++) await nextFrame();
    const readingTop = viewport.scrollTop;
    const row = viewport.querySelector("[data-history-row-id]");
    if (!(row instanceof HTMLElement)) throw Error("Virtual history did not mount");

    flushSync(() => root.render(<Chat active={false} />));
    for (let frame = 0; frame < 3; frame++) await nextFrame();
    expect(viewport.getBoundingClientRect().width).toBe(0);

    flushSync(() => root.render(<Chat active />));
    const returnedCounts: number[] = [];
    const returnedOffsets: number[] = [];
    for (let frame = 0; frame < 3; frame++) {
      await nextFrame();
      returnedCounts.push(viewport.querySelectorAll("[data-history-row-id]").length);
      returnedOffsets.push(viewport.scrollTop);
    }
    expect(returnedCounts.every((count) => count > 0)).toBe(true);
    expect(returnedOffsets).toEqual([readingTop, readingTop, readingTop]);
    expect(host.querySelector('[data-testid="agent-chat-scroll"]')).toBe(viewport);
    expect(viewport.querySelector(`[data-history-row-id="${row.dataset.historyRowId}"]`)).toBe(row);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});

it("follows new messages received while frozen and still anchors a new route activation", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:800px;height:500px";
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<Chat active />));
    const viewport = host.querySelector('[data-testid="agent-chat-scroll"]');
    if (!(viewport instanceof HTMLElement)) throw Error("Chat viewport did not mount");
    await vi.waitFor(() =>
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(1),
    );
    flushSync(() => root.render(<Chat active={false} />));
    for (let frame = 0; frame < 3; frame++) await nextFrame();
    flushSync(() => root.render(<Chat active renderInput={updatedInput} />));
    for (let frame = 0; frame < 3; frame++) {
      await nextFrame();
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(1);
    }
    const arrived = viewport.querySelector('[data-history-row-id="new-message"]');
    expect(arrived).not.toBeNull();

    viewport.scrollTop = 5000;
    flushSync(() => root.render(<Chat active renderInput={newRouteInput} />));
    expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThanOrEqual(
      1,
    );
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});
