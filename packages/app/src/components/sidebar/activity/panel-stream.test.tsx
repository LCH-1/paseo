/** @vitest-environment jsdom */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { SidebarActivityPanel } from "./panel";

const state = vi.hoisted(() => ({
  agents: [] as AggregatedAgent[],
  rowRenders: 0,
  rowRendersByAgent: {} as Record<string, number>,
}));
vi.mock("@/desktop/host", () => ({ getDesktopHost: () => null }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: () => undefined }) }));
vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({ projects: [], hostErrors: [], isLoading: false, refetch: () => undefined }),
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
  getHostRuntimeStore: () => ({ getClient: () => null }),
}));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: vi.fn() }));
// Every activity row asks for its tab title once per render, so this counts row renders.
vi.mock("@/plugins/agent-tab-titles/use-title", () => ({
  useAgentTabTitle: ({ agentId }: { agentId: string }) => {
    state.rowRenders += 1;
    state.rowRendersByAgent[agentId] = (state.rowRendersByAgent[agentId] ?? 0) + 1;
    return "Conversation";
  },
}));

const AT = new Date("2026-11-10T00:00:00.000Z");
function runningAgent(id: string): Agent {
  return {
    serverId: "host",
    id,
    provider: "codex",
    status: "running",
    turn: { phase: "open", turnId: `turn-${id}`, startedAt: AT, cancellationRequestId: null },
    createdAt: AT,
    updatedAt: AT,
    lastUserMessageAt: AT,
    lastActivityAt: AT,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: id,
    cwd: "/repo",
    workspaceId: "workspace",
    model: null,
    parentAgentId: null,
    labels: {},
  };
}
function listed(agent: Agent): AggregatedAgent {
  return { ...agent, serverLabel: "Company", pendingPermissionCount: 0 };
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  state.rowRenders = 0;
  state.rowRendersByAgent = {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSessionStore.getState().clearSession("host");
  useSessionStore.getState().clearSession("gaming");
});

function renderRunningList(listedIds: string[], unlistedIds: string[]) {
  const store = useSessionStore.getState();
  store.initializeSession("host", null as unknown as DaemonClient);
  store.initializeSession("gaming", null as unknown as DaemonClient);
  const agents = listedIds.map(runningAgent);
  store.setAgents(
    "host",
    new Map([...agents, ...unlistedIds.map(runningAgent)].map((agent) => [agent.id, agent])),
  );
  state.agents = agents.map(listed);
  const screen = render(
    <QueryClientProvider client={new QueryClient()}>
      <SidebarActivityPanel active>
        <span>Workspaces</span>
      </SidebarActivityPanel>
    </QueryClientProvider>,
  );
  fireEvent.click(
    screen.getByRole("tab", { name: `sidebar.activity.running ${listedIds.length}` }),
  );
  for (const id of listedIds) {
    expect(screen.getByTestId(`sidebar-activity-session-host-${id}`)).toBeTruthy();
  }
  return screen;
}

it("does not redraw the running rows while other conversations stream", () => {
  renderRunningList(["first", "second"], ["hidden"]);
  const drawn = state.rowRenders;
  expect(drawn).toBeGreaterThan(0);

  for (let tick = 0; tick < 100; tick += 1) {
    act(() => {
      useSessionStore
        .getState()
        .setAgentStreamState(tick % 2 ? "host" : "gaming", tick % 2 ? "hidden" : "remote", {
          head: [
            {
              kind: "assistant_message",
              id: "message",
              text: `token ${tick}`,
              timestamp: new Date(AT.getTime() + tick),
            },
          ],
        });
    });
  }

  expect(state.rowRenders).toBe(drawn);
});

it("redraws only the running row whose reply streams", () => {
  renderRunningList(["first", "second", "third"], []);
  const drawn = { ...state.rowRendersByAgent };
  expect(drawn.second).toBeGreaterThan(0);

  // Each chunk extends the reply and moves its timestamp, as the stream reducer does.
  for (let tick = 0; tick < 100; tick += 1) {
    act(() => {
      useSessionStore.getState().setAgentStreamState("host", "first", {
        head: [
          {
            kind: "assistant_message",
            id: "message",
            text: "x".repeat(tick + 1),
            timestamp: new Date(AT.getTime() + tick),
          },
        ],
      });
    });
  }

  expect(state.rowRendersByAgent.first).toBeGreaterThan(drawn.first);
  expect(state.rowRendersByAgent.second).toBe(drawn.second);
  expect(state.rowRendersByAgent.third).toBe(drawn.third);
});
