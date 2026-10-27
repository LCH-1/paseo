/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useAgentAttentionClear } from "./use-agent-attention-clear";

const visibility = vi.hoisted(() => ({ active: true }));
vi.mock("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock("@/utils/app-visibility", () => ({ getIsAppActivelyVisible: () => visibility.active }));
vi.mock("@/constants/platform", () => ({ isWeb: true }));
const clear = vi.fn().mockResolvedValue(undefined);
const client = { clearAgentAttention: clear } as unknown as DaemonClient;
const initial = {
  agentId: "agent-a",
  client,
  isConnected: true,
  requiresAttention: true,
  attentionReason: "finished" as "finished" | "permission" | "error" | null,
  isScreenFocused: true,
  isContentReady: true,
};
beforeEach(() => {
  visibility.active = true;
  clear.mockClear();
});
afterEach(cleanup);

describe("read completed conversations", () => {
  it("clears a finished conversation once it is displayed", () => {
    renderHook(() => useAgentAttentionClear(initial));
    expect(clear).toHaveBeenCalledExactlyOnceWith("agent-a");
  });
  it("clears when a turn finishes in the conversation being read", () => {
    const view = renderHook(useAgentAttentionClear, {
      initialProps: { ...initial, requiresAttention: false },
    });
    view.rerender(initial);
    expect(clear).toHaveBeenCalledExactlyOnceWith("agent-a");
  });
  it("waits for content and retries after a late connection", () => {
    const view = renderHook(useAgentAttentionClear, {
      initialProps: { ...initial, isContentReady: false, isConnected: false },
    });
    view.rerender({ ...initial, isContentReady: false });
    expect(clear).not.toHaveBeenCalled();
    view.rerender(initial);
    expect(clear).toHaveBeenCalledExactlyOnceWith("agent-a");
  });
  it("retries a displayed unread conversation on reconnect", () => {
    const view = renderHook(useAgentAttentionClear, {
      initialProps: { ...initial, isConnected: false },
    });
    expect(clear).not.toHaveBeenCalled();
    view.rerender(initial);
    expect(clear).toHaveBeenCalledExactlyOnceWith("agent-a");
  });
  it("leaves a background tab unread until it is focused", () => {
    const view = renderHook(useAgentAttentionClear, {
      initialProps: { ...initial, isScreenFocused: false },
    });
    expect(clear).not.toHaveBeenCalled();
    view.rerender(initial);
    expect(clear).toHaveBeenCalledExactlyOnceWith("agent-a");
  });
  it("does not read a retained pane until its conversation is displayed", () => {
    const view = renderHook(useAgentAttentionClear, {
      initialProps: { ...initial, isContentReady: false },
    });
    expect(clear).not.toHaveBeenCalled();
    view.rerender(initial);
    expect(clear).toHaveBeenCalledExactlyOnceWith("agent-a");
  });
  it("waits while the app is in the background", () => {
    visibility.active = false;
    renderHook(() => useAgentAttentionClear(initial));
    expect(clear).not.toHaveBeenCalled();
    act(() => {
      visibility.active = true;
      window.dispatchEvent(new Event("focus"));
    });
    expect(clear).toHaveBeenCalledExactlyOnceWith("agent-a");
  });
  it("never clears permission attention by displaying a conversation", () => {
    const view = renderHook(useAgentAttentionClear, {
      initialProps: { ...initial, attentionReason: "permission" as typeof initial.attentionReason },
    });
    expect(clear).not.toHaveBeenCalled();
    act(() => view.result.current.clearOnInputFocus());
    expect(clear).not.toHaveBeenCalled();
  });
  it("keeps existing explicit acknowledgement for errors arriving while viewed", () => {
    const view = renderHook(useAgentAttentionClear, {
      initialProps: { ...initial, requiresAttention: false },
    });
    view.rerender({ ...initial, attentionReason: "error" });
    expect(clear).not.toHaveBeenCalled();
    act(() => view.result.current.clearOnInputFocus());
    expect(clear).toHaveBeenCalledExactlyOnceWith("agent-a");
  });
});
