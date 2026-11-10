/** @vitest-environment jsdom */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { agentTabPresenceBridge } from "@/workspace-tabs/agent-tab-presence";
import { SessionHistoryTable } from "./session-history-table";

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => null }),
}));
vi.mock("@/hooks/use-archive-agent", () => ({
  useArchiveAgent: () => ({ archiveAgent: vi.fn() }),
}));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: vi.fn() }));

const AT = new Date("2026-11-10T00:00:00.000Z");
const AGENTS: AggregatedAgent[] = [
  {
    id: "agent",
    serverId: "host",
    serverLabel: "Company",
    title: "Conversation",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    lastActivityAt: AT,
    lastUserMessageAt: null,
    cwd: "/repo",
    workspaceId: "workspace",
    provider: "codex",
    pendingPermissionCount: 0,
    createdAt: AT,
    labels: {},
  },
];
const refresh = () => undefined;

beforeEach(() => {
  vi.stubGlobal("React", React);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows a tab opening on a row whose conversation did not change", () => {
  const presence = { isOpen: false, lastClosedAt: null };
  let announce = () => {};
  const release = agentTabPresenceBridge.register({
    read: () => ({ ...presence }),
    subscribe: (listener) => {
      announce = listener;
      return () => {};
    },
  });
  const screen = render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionHistoryTable
        agents={AGENTS}
        isRefreshing={false}
        onRefresh={refresh}
        footer={null}
        isLoadingPages={false}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByTestId("history-row-host-agent")).toBeTruthy();
  expect(screen.queryByText("열림")).toBeNull();

  act(() => {
    presence.isOpen = true;
    announce();
  });

  expect(screen.getByText("열림")).toBeTruthy();
  release();
});
