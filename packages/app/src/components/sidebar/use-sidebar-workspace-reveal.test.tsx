/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarRevealStore } from "@/stores/sidebar-reveal-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { sidebarHostProjectKey } from "./host-project-groups";
import { useSidebarWorkspaceReveal } from "./use-sidebar-workspace-reveal";
import { useLimitedSidebarGroup } from "./use-limited-sidebar-group";
import { followSidebarWorkspace } from "./sidebar-workspace-scroll";

vi.mock("./sidebar-workspace-scroll", () => ({ followSidebarWorkspace: vi.fn(() => vi.fn()) }));

const workspace: SidebarWorkspacePlacement = {
  workspaceKey: "host-a:workspace-a",
  serverId: "host-a",
  workspaceId: "workspace-a",
  projectViewKey: "project-a",
  projectName: "Project",
  projectKind: "git",
  workspaceKind: "local_checkout",
  name: "Workspace",
};
const project: SidebarProjectEntry = {
  viewKey: "project-a",
  projectName: "Project",
  projectKind: "git",
  iconWorkingDir: "/project",
  hosts: [],
  workspaces: [workspace],
};
const collapseKey = sidebarHostProjectKey({
  serverId: "host-a",
  projectViewKey: "project-a",
});
const input = {
  projects: [project],
  pinnedGroups: { pinnedChats: [], unpinnedProjects: [project] },
  workspaceGroups: [],
  groupMode: "host" as const,
};
function reveal() {
  act(() => {
    useSidebarRevealStore.getState().reveal({ serverId: "host-a", workspaceId: "workspace-a" });
  });
}
beforeEach(() => {
  useSidebarRevealStore.setState({ request: null });
  useSidebarCollapsedSectionsStore.setState({
    collapsedProjectKeys: new Set([collapseKey, "other"]),
    collapsedWorkspaceGroupKeys: new Set(["host:host-a", "host:host-b"]),
    collapsedPinned: true,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("sidebar workspace reveal", () => {
  it("opens only the selected host and project and preserves manual collapse until another activation", () => {
    const view = renderHook(() => useSidebarWorkspaceReveal(input));
    reveal();
    expect(useSidebarCollapsedSectionsStore.getState().collapsedProjectKeys).toEqual(
      new Set(["other"]),
    );
    expect(useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys).toEqual(
      new Set(["host:host-b"]),
    );
    act(() => {
      useSidebarCollapsedSectionsStore.getState().setProjectCollapsed(collapseKey, true);
    });
    view.rerender();
    expect(useSidebarCollapsedSectionsStore.getState().collapsedProjectKeys.has(collapseKey)).toBe(
      true,
    );
    reveal();
    expect(useSidebarCollapsedSectionsStore.getState().collapsedProjectKeys.has(collapseKey)).toBe(
      false,
    );
  });
  it("reveals a pinned workspace and waits for late directory hydration", () => {
    const view = renderHook(
      ({ ready }) =>
        useSidebarWorkspaceReveal({
          ...input,
          projects: [],
          pinnedGroups: {
            pinnedChats: ready ? [workspace] : [],
            unpinnedProjects: [],
          },
        }),
      { initialProps: { ready: false } },
    );
    reveal();
    expect(useSidebarCollapsedSectionsStore.getState().collapsedPinned).toBe(true);
    view.rerender({ ready: true });
    expect(useSidebarCollapsedSectionsStore.getState().collapsedPinned).toBe(false);
  });
  it("does not match another host with the same workspace id", () => {
    renderHook(() => useSidebarWorkspaceReveal(input));
    act(() => {
      useSidebarRevealStore.getState().reveal({ serverId: "host-b", workspaceId: "workspace-a" });
    });
    expect(useSidebarCollapsedSectionsStore.getState().collapsedProjectKeys.has(collapseKey)).toBe(
      true,
    );
  });
  it("opens only the matching status group in status mode", () => {
    useSidebarCollapsedSectionsStore.setState({
      collapsedWorkspaceGroupKeys: new Set(["running", "done", "host:host-a"]),
    });
    renderHook(() =>
      useSidebarWorkspaceReveal({
        ...input,
        groupMode: "status",
        projects: [],
        workspaceGroups: [
          {
            key: "running",
            label: "Running",
            leading: { kind: "status", bucket: "running" },
            rows: [
              {
                ...workspace,
                title: null,
                workspaceDirectory: "/project",
                workspaceDirectoryLabel: "project",
                currentBranch: null,
                statusBucket: "running",
                statusEnteredAt: null,
                archivingAt: null,
                diffStat: null,
                prHint: null,
                archiveHasUncommittedChanges: null,
                archiveUnpushedCommitCount: null,
                scripts: [],
                hasRunningScripts: false,
              },
            ],
          },
        ],
      }),
    );
    reveal();
    expect(useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys).toEqual(
      new Set(["done", "host:host-a"]),
    );
  });
  it("expands the show-more limit for the selected workspace without pinning or reordering", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      workspaceKey: "host-a:workspace-" + i,
    }));
    const view = renderHook(() => useLimitedSidebarGroup(items));
    expect(view.result.current.visibleItems).toHaveLength(20);
    act(() => {
      useSidebarRevealStore.getState().reveal({ serverId: "host-a", workspaceId: "workspace-24" });
    });
    expect(view.result.current.visibleItems.map((item) => item.workspaceKey)).toEqual(
      items.map((item) => item.workspaceKey),
    );
    act(() => view.result.current.toggleExpanded());
    expect(view.result.current.visibleItems).toHaveLength(20);
  });
  it("restarts viewport tracking on every activation and stops it on unmount", () => {
    const stop = vi.fn();
    vi.mocked(followSidebarWorkspace).mockReturnValue(stop);
    const view = renderHook(() => useSidebarWorkspaceReveal(input));
    reveal();
    expect(followSidebarWorkspace).toHaveBeenLastCalledWith("host-a:workspace-a");
    reveal();
    expect(stop).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
