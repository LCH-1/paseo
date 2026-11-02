/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { SidebarActivityPanel } from "./panel";

const state = vi.hoisted(() => ({ agents: [] as AggregatedAgent[] }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-aggregated-agents", () => ({
  useAggregatedAgents: () => ({ agents: state.agents, isInitialLoad: false }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "host" }],
  getHostRuntimeStore: vi.fn(),
}));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: vi.fn() }));
vi.mock("@/plugins/agent-tab-titles/use-title", () => ({ useAgentTabTitle: () => "Conversation" }));
vi.mock("@/screens/session-history/use-history-conversations", () => ({
  useHistoryConversations: (agents: AggregatedAgent[]) => ({
    rows: agents.map((agent) => ({
      agent,
      isLoading: false,
      isError: false,
      summary: { lastRequestAt: null, lastResponseAt: null, preview: "", previewAt: null },
    })),
  }),
}));

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each(["running", "unreviewed"])(
  "keeps the clicked %s row through the second click after it leaves the filter",
  (view) => {
    vi.useFakeTimers();
    const working = view === "running";
    state.agents = [
      {
        id: "agent",
        serverId: "host",
        serverLabel: "Host",
        workspaceId: "workspace",
        title: "Agent",
        cwd: "/repo",
        provider: "codex",
        status: "idle",
        turn: working
          ? { phase: "open", turnId: "turn", startedAt: null, cancellationRequestId: null }
          : { phase: "idle", cancellationRequestId: null },
        requiresAttention: !working,
        attentionReason: working ? null : "finished",
        attentionTimestamp: null,
        pendingPermissionCount: 0,
        archivedAt: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        labels: {},
      },
    ];
    const element = () => (
      <SidebarActivityPanel active>
        <span>Workspaces</span>
      </SidebarActivityPanel>
    );
    const screen = render(element());
    fireEvent.click(screen.getByRole("tab", { name: `sidebar.activity.${view} 1` }));
    const row = screen.getByTestId("sidebar-activity-session-host-agent");
    fireEvent.click(row);
    state.agents = [];
    screen.rerender(element());
    expect(screen.getByTestId("sidebar-activity-session-host-agent")).toBe(row);
    act(() => vi.advanceTimersByTime(200));
    fireEvent.click(row);
    expect(navigateToAgent).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(601));
    expect(screen.queryByTestId("sidebar-activity-session-host-agent")).toBeNull();
  },
);
