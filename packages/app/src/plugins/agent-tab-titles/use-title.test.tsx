/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { PluginAgentTabTitleContext } from "@getpaseo/plugin/client";
import { useAgentTabTitle } from "./use-title";

const fixture = vi.hoisted(() => ({
  state: {
    sessions: {} as Record<string, {
      agents: Map<string, { workspaceId: string }>;
      agentDetails: Map<string, { workspaceId: string }>;
      workspaces: Map<string, WorkspaceDescriptor>;
    }>,
  },
  listeners: new Set<() => void>(),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ settings: { workspaceTitleSource: "title" } }),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: typeof fixture.state) => unknown) =>
    useSyncExternalStore(
      (listener) => {
        fixture.listeners.add(listener);
        return () => fixture.listeners.delete(listener);
      },
      () => select(fixture.state),
    ),
}));

vi.mock("../registry", () => ({
  useInstalledPlugins: () => [{
    id: "sync", serverId: "host-a", lifetime: new AbortController(),
    agentTabTitleResolvers: [{ id: "two-lines", resolve: (context: PluginAgentTabTitleContext) =>
      context.projectLabel && context.sidebarLabel
        ? { primaryLabel: context.projectLabel, secondaryLabel: context.sidebarLabel }
        : null,
    }],
  }],
}));

const workspace = {
  id: "workspace-a", projectDisplayName: "Original project", projectCustomName: null,
  name: "main", projectId: "project-a",
} as WorkspaceDescriptor;
const context = {
  serverId: "host-a", workspaceId: "workspace-a", agentId: "agent-a", defaultLabel: "Saved title",
};

beforeEach(() => {
  fixture.state = { sessions: {} };
  fixture.listeners.clear();
});
afterEach(cleanup);

function publishWorkspace(nextWorkspace: WorkspaceDescriptor) {
  act(() => {
    fixture.state = { sessions: {
      "host-a": {
        agents: new Map([["agent-a", { workspaceId: "workspace-a" }]]),
        agentDetails: new Map(), workspaces: new Map([["workspace-a", nextWorkspace]]),
      },
    } };
    for (const listener of fixture.listeners) listener();
  });
}

describe("reactive agent tab title", () => {
  it("recovers after metadata arrives and reacts to a project-only rename without plugin polling", () => {
    const view = renderHook(() => useAgentTabTitle(context));
    expect(view.result.current).toBeNull();
    publishWorkspace(workspace);
    expect(view.result.current).toEqual({ primaryLabel: "Original project", secondaryLabel: "main" });
    publishWorkspace({ ...workspace, projectCustomName: "Renamed project" });
    expect(view.result.current).toEqual({ primaryLabel: "Renamed project", secondaryLabel: "main" });
    publishWorkspace({ ...workspace, projectCustomName: "Renamed project", name: "workspace two" });
    expect(view.result.current).toEqual({ primaryLabel: "Renamed project", secondaryLabel: "workspace two" });
    view.unmount();
    expect(fixture.listeners.size).toBe(0);
  });
});
