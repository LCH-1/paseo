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
  attentionTimestamp: null as Date | number | null,
  isScreenFocused: true,
  isContentReady: true,
};

function pendingAcknowledgement() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  visibility.active = true;
  clear.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("read completed conversations", () => {
  it("retries a displayed completion after a transient acknowledgement failure", async () => {
    vi.useFakeTimers();
    clear.mockRejectedValueOnce(new Error("temporary acknowledgement failure"));
    renderHook(() => useAgentAttentionClear(initial));
    await act(async () => {});
    expect(clear).toHaveBeenCalledExactlyOnceWith("agent-a");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(clear).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(clear).toHaveBeenCalledTimes(2);
  });
  it("keeps retrying slowly after three quick retries while a displayed completion keeps failing", async () => {
    vi.useFakeTimers();
    clear.mockRejectedValue(new Error("acknowledgement timed out"));
    const view = renderHook(useAgentAttentionClear, { initialProps: initial });
    await act(async () => {});
    expect(clear).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(clear).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1499);
    });
    expect(clear).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(clear).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(clear).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(clear).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(clear).toHaveBeenCalledTimes(5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(clear).toHaveBeenCalledTimes(15);
    view.rerender({ ...initial, isScreenFocused: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(clear).toHaveBeenCalledTimes(15);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops the slow retries once the host acknowledges the completion", async () => {
    vi.useFakeTimers();
    clear.mockRejectedValue(new Error("acknowledgement timed out"));
    renderHook(() => useAgentAttentionClear(initial));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(clear).toHaveBeenCalledTimes(4);
    clear.mockResolvedValue(undefined);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(clear).toHaveBeenCalledTimes(5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(clear).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each<[string, Partial<typeof initial>]>([
    ["loses pane focus", { isScreenFocused: false }],
    ["waits for content", { isContentReady: false }],
    ["disconnects", { isConnected: false }],
    ["becomes read", { requiresAttention: false }],
    ["requires permission", { attentionReason: "permission" }],
    ["requires explicit error acknowledgement", { attentionReason: "error" }],
  ])("cancels a pending completion retry when the conversation %s", async (_, patch) => {
    vi.useFakeTimers();
    clear.mockRejectedValue(new Error("temporary acknowledgement failure"));
    const view = renderHook(useAgentAttentionClear, { initialProps: initial });
    await act(async () => {});
    view.rerender({ ...initial, ...patch });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(clear).toHaveBeenCalledExactlyOnceWith("agent-a");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels retries in the background and retries once when the app is focused again", async () => {
    vi.useFakeTimers();
    clear.mockRejectedValueOnce(new Error("temporary acknowledgement failure"));
    renderHook(() => useAgentAttentionClear(initial));
    await act(async () => {});
    act(() => {
      visibility.active = false;
      window.dispatchEvent(new Event("blur"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(clear).toHaveBeenCalledTimes(1);
    act(() => {
      visibility.active = true;
      window.dispatchEvent(new Event("focus"));
    });
    expect(clear).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(clear).toHaveBeenCalledTimes(2);
  });
  it("cancels a pending acknowledgement retry on unmount", async () => {
    vi.useFakeTimers();
    clear.mockRejectedValue(new Error("temporary acknowledgement failure"));
    const view = renderHook(() => useAgentAttentionClear(initial));
    await act(async () => {});
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("acknowledges a new completion timestamp without repeating the same timestamp", async () => {
    const first = { ...initial, attentionTimestamp: new Date(1000) };
    const view = renderHook(useAgentAttentionClear, { initialProps: initial });
    await act(async () => {});
    view.rerender(first);
    await act(async () => {});
    expect(clear).toHaveBeenCalledTimes(2);
    view.rerender({ ...initial, attentionTimestamp: new Date(1000) });
    view.rerender({ ...initial, attentionTimestamp: 1000 });
    expect(clear).toHaveBeenCalledTimes(2);
    view.rerender({ ...initial, attentionTimestamp: 2000 });
    expect(clear).toHaveBeenCalledTimes(3);
  });
  it("a late failure from the previous conversation cannot schedule retries for its successor", async () => {
    vi.useFakeTimers();
    const previous = pendingAcknowledgement();
    clear.mockReturnValueOnce(previous.promise);
    const view = renderHook(useAgentAttentionClear, { initialProps: initial });
    view.rerender({ ...initial, agentId: "agent-b" });
    await act(async () => {
      previous.reject(new Error("late previous conversation failure"));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(clear.mock.calls).toEqual([["agent-a"], ["agent-b"]]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a late success from an older completion cannot cancel the new completion retry", async () => {
    vi.useFakeTimers();
    const previous = pendingAcknowledgement();
    clear
      .mockReturnValueOnce(previous.promise)
      .mockRejectedValueOnce(new Error("new completion failure"));
    const view = renderHook(useAgentAttentionClear, {
      initialProps: { ...initial, attentionTimestamp: 1000 },
    });
    view.rerender({ ...initial, attentionTimestamp: 2000 });
    await act(async () => {});
    await act(async () => {
      previous.resolve();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(clear.mock.calls).toEqual([["agent-a"], ["agent-a"], ["agent-a"]]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(clear).toHaveBeenCalledTimes(3);
  });
  it("shares an in-flight acknowledgement with explicit actions and a rapid return to its conversation", async () => {
    vi.useFakeTimers();
    const first = pendingAcknowledgement();
    const second = pendingAcknowledgement();
    clear.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = renderHook(useAgentAttentionClear, { initialProps: initial });
    act(() => {
      view.result.current.clearOnInputFocus();
      view.result.current.clearOnPromptSend();
      view.result.current.clearOnAgentBlur();
    });
    expect(clear).toHaveBeenCalledExactlyOnceWith("agent-a");
    view.rerender({ ...initial, agentId: "agent-b" });
    view.rerender(initial);
    expect(clear.mock.calls).toEqual([["agent-a"], ["agent-b"]]);
    await act(async () => {
      first.resolve();
      second.reject(new Error("late background conversation failure"));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(clear.mock.calls).toEqual([["agent-a"], ["agent-b"]]);
    expect(vi.getTimerCount()).toBe(0);
  });
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
