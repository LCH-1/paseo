import { useEffect, useRef } from "react";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { useSidebarRevealStore } from "@/stores/sidebar-reveal-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import type { SidebarWorkspaceGroup } from "./sidebar-labels";
import { sidebarHostGroupKey, sidebarHostProjectKey } from "./host-project-groups";

interface SidebarRevealInput {
  projects: readonly SidebarProjectEntry[];
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: readonly SidebarWorkspaceGroup[];
  groupMode: SidebarGroupMode;
}

export function useSidebarWorkspaceReveal(input: SidebarRevealInput): void {
  const { projects, pinnedGroups, workspaceGroups, groupMode } = input;
  const request = useSidebarRevealStore((state) => state.request);
  const processed = useRef(0);
  useEffect(() => {
    if (!request || processed.current === request.sequence) return;
    const workspaceKey = `${request.serverId}:${request.workspaceId}`;
    const project = projects.find((item) =>
      item.workspaces.some((row) => row.workspaceKey === workspaceKey),
    );
    const pinned = pinnedGroups.pinnedChats.some((row) => row.workspaceKey === workspaceKey);
    const group = workspaceGroups.find((item) =>
      item.rows.some((row) => row.workspaceKey === workspaceKey),
    );
    if (!project && !pinned && !group) return;
    processed.current = request.sequence;
    const collapsed = useSidebarCollapsedSectionsStore.getState();
    if (pinned && collapsed.collapsedPinned) collapsed.togglePinnedCollapsed();
    if (project && !pinned && groupMode !== "status") {
      const key =
        groupMode === "host"
          ? sidebarHostProjectKey({
              serverId: request.serverId,
              projectViewKey: project.viewKey,
            })
          : project.viewKey;
      collapsed.setProjectsCollapsed([key], false);
    }
    const groupKeys = groupMode === "host" ? [sidebarHostGroupKey(request.serverId)] : [];
    if (group && groupMode === "status") groupKeys.push(group.key);
    collapsed.setWorkspaceGroupsCollapsed(groupKeys, false);
  }, [request, projects, pinnedGroups, workspaceGroups, groupMode]);

  useEffect(() => {
    if (!request || typeof document === "undefined") return;
    const testId = `sidebar-workspace-row-${request.serverId}:${request.workspaceId}`;
    let frame = 0;
    function reveal(): void {
      const rows = document.querySelectorAll<HTMLElement>(
        '[data-testid^="sidebar-workspace-row-"]',
      );
      const row = Array.from(rows).find(
        (element) =>
          element.dataset.testid === testId && element.getBoundingClientRect().height > 0,
      );
      if (!row) return;
      row.scrollIntoView({ block: "nearest", inline: "nearest" });
      observer.disconnect();
      clearTimeout(timeout);
    }
    function schedule(): void {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reveal);
    }
    const observer = new MutationObserver(schedule);
    const sidebar = document.querySelector(
      '[data-testid="sidebar-project-workspace-list-scroll"],[data-testid="sidebar-status-list-scroll"]',
    );
    observer.observe(sidebar ?? document.body, { childList: true, subtree: true });
    const timeout = setTimeout(() => observer.disconnect(), 2000);
    schedule();
    return () => {
      observer.disconnect();
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
    };
  }, [request]);
}
