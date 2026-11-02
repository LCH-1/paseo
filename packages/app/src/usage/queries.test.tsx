/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type PropsWithChildren } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentUsage, useHostUsage, useUsageHostReports } from "./queries";

const fixture = vi.hoisted(() => ({
  connected: true,
  supported: true,
  list: vi.fn(),
}));
vi.mock("@getpaseo/client/internal/daemon-client", () => ({
  supportsUsageReports: () => fixture.supported,
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: () => ({ listUsageReports: fixture.list }),
  }),
  useHostRuntimeIsConnected: () => fixture.connected,
  useHostRuntimeConnectionStatuses: () => new Map(),
  useHosts: () => [],
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ sessions: { host: { serverInfo: { features: {} } } } }),
}));

let queryClient: QueryClient;
const report = (percent: number) => ({
  id: "claude:account",
  sourceId: "claude",
  sourceLabel: "Claude",
  account: {},
  fetchedAt: new Date().toISOString(),
  report: {
    status: "available",
    windows: [{ id: "weekly", usedPct: percent }],
  },
});
const wrapper = ({ children }: PropsWithChildren) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

beforeEach(() => {
  vi.useFakeTimers();
  fixture.connected = true;
  fixture.supported = true;
  fixture.list.mockReset();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  fixture.list.mockImplementation(async (_options, onReport) => {
    const entry = report(fixture.list.mock.calls.length);
    onReport?.(entry);
    return { reports: [entry] };
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.useRealTimers();
});

it("updates a mounted sidebar without manual refresh and keeps automatic reads cache-aware", async () => {
  const view = renderHook(() => useUsageHostReports("host"), { wrapper });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(fixture.list).toHaveBeenCalledTimes(1);
  expect(view.result.current[0].report).toMatchObject({
    windows: [{ usedPct: 1 }],
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fixture.list).toHaveBeenCalledTimes(2);
  expect(view.result.current[0].report).toMatchObject({
    windows: [{ usedPct: 2 }],
  });
  expect(
    fixture.list.mock.calls.every(([options]) => options.forceRefresh === false)
  ).toBe(true);
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(fixture.list).toHaveBeenCalledTimes(2);
});

it("does not poll a disconnected or unsupported host and starts when the host reconnects", async () => {
  fixture.connected = false;
  const view = renderHook(() => useUsageHostReports("host"), { wrapper });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(fixture.list).not.toHaveBeenCalled();
  fixture.connected = true;
  view.rerender();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(fixture.list).toHaveBeenCalledTimes(1);
  fixture.supported = false;
  view.rerender();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(fixture.list).toHaveBeenCalledTimes(1);
});

it.each([
  ["host settings", () => useHostUsage("host")],
  ["agent details", () => useAgentUsage("host", "agent")],
] as const)("automatically refreshes open %s", async (_label, hook) => {
  renderHook(hook, { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(fixture.list).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fixture.list).toHaveBeenCalledTimes(2);
});

it("shares sidebar and settings reads while preserving explicit cache-bypassing refresh", async () => {
  renderHook(() => useUsageHostReports("host"), { wrapper });
  const settings = renderHook(() => useHostUsage("host"), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(fixture.list).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fixture.list).toHaveBeenCalledTimes(2);
  await act(async () => { settings.result.current.refresh(); await vi.advanceTimersByTimeAsync(10); });
  expect(fixture.list).toHaveBeenCalledTimes(3);
  expect(fixture.list.mock.calls[2][0].forceRefresh).toBe(true);
});
