/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { UseProjectsResult } from "@/hooks/use-projects";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { SidebarActivityPanel } from "./panel";

const state = vi.hoisted(() => ({
  agents: [] as AggregatedAgent[],
  projects: [] as UseProjectsResult["projects"],
  hostErrors: [] as UseProjectsResult["hostErrors"],
  native: true,
  openProject: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  toastError: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => (state.native ? { window: { openProject: state.openProject } } : null),
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: state.toastError }) }));
vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({
    projects: state.projects,
    hostErrors: state.hostErrors,
    isLoading: false,
    refetch: state.refetch,
  }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-aggregated-agents", () => ({
  useAggregatedAgents: () => ({ agents: state.agents, isInitialLoad: false }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [
    { serverId: "host", label: "Company" },
    { serverId: "gaming", label: "Gaming" },
  ],
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

beforeEach(() => {
  vi.stubGlobal("React", React);
  state.native = true;
  state.projects = [];
  state.hostErrors = [];
  state.openProject.mockResolvedValue(undefined);
});
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
    expect(screen.getByRole("img", { name: "Codex" })).toBeTruthy();
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

function projectCatalog(): UseProjectsResult["projects"] {
  const hosts = ["host", "gaming"].map((serverId) => ({
    serverId,
    projectId: `${serverId}-project`,
    projectName: "repo",
    projectCustomName: null,
    serverName: serverId,
    isOnline: true,
    repoRoot: `/${serverId}/repo`,
    workspaceCount: 0,
    workspaces: [],
  }));
  return [
    {
      viewKey: "shared",
      projectName: "repo",
      hosts,
      totalWorkspaceCount: 0,
      hostCount: 2,
      onlineHostCount: 2,
    },
  ];
}

it("groups projects by host and opens the selected host's own project", async () => {
  state.projects = projectCatalog();
  const screen = render(
    <SidebarActivityPanel active>
      <span>Workspaces</span>
    </SidebarActivityPanel>,
  );
  fireEvent.click(screen.getByRole("tab", { name: "settings.projects" }));
  const list = within(screen.getByTestId("sidebar-project-list"));
  expect(list.getByRole("heading", { name: "Company" })).toBeTruthy();
  expect(list.getByRole("heading", { name: "Gaming" })).toBeTruthy();
  await act(async () => fireEvent.click(list.getByTestId("sidebar-project-gaming:gaming-project")));
  expect(state.openProject).toHaveBeenCalledExactlyOnceWith({
    serverId: "gaming",
    projectId: "gaming-project",
    projectName: "repo",
    directory: "/gaming/repo",
  });
});

it("blocks duplicate opens and allows retry after a rejected native open", async () => {
  state.projects = projectCatalog();
  let rejectOpen: (error: Error) => void = () => undefined;
  state.openProject.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectOpen = reject;
    }),
  );
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const screen = render(
      <SidebarActivityPanel active>
        <span>Workspaces</span>
      </SidebarActivityPanel>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "settings.projects" }));
    const row = screen.getByTestId("sidebar-project-host:host-project");
    fireEvent.click(row);
    fireEvent.click(row);
    expect(state.openProject).toHaveBeenCalledTimes(1);
    await act(async () => rejectOpen(new Error("IPC unavailable")));
    expect(state.toastError).toHaveBeenCalledWith("sidebar.project.actions.openNewWindowFailed");
    await act(async () => fireEvent.click(row));
    expect(state.openProject).toHaveBeenCalledTimes(2);
  } finally {
    warning.mockRestore();
  }
});

it("keeps available projects visible when another host fails and offers retry", () => {
  state.projects = projectCatalog();
  state.hostErrors = [{ serverId: "other", serverName: "Other", message: "Unavailable" }];
  const screen = render(
    <SidebarActivityPanel active>
      <span>Workspaces</span>
    </SidebarActivityPanel>,
  );
  fireEvent.click(screen.getByRole("tab", { name: "settings.projects" }));
  expect(screen.getByRole("alert").textContent).toBe("settings.projectList.hostLoadFailed");
  expect(screen.getByTestId("sidebar-project-host:host-project")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "common.actions.retry" }));
  expect(state.refetch).toHaveBeenCalledTimes(1);
});

it("hides the native project window action when no desktop bridge is available", () => {
  state.native = false;
  const screen = render(
    <SidebarActivityPanel active>
      <span>Workspaces</span>
    </SidebarActivityPanel>,
  );
  expect(screen.queryByRole("tab", { name: "settings.projects" })).toBeNull();
});
