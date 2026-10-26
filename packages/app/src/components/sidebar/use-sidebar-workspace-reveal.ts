import { useEffect, useRef } from "react";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { useSidebarRevealStore } from "@/stores/sidebar-reveal-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import type { SidebarWorkspaceGroup } from "./sidebar-labels";
import { sidebarHostGroupKey, sidebarHostProjectKey } from "./host-project-groups";
import { followSidebarWorkspace } from "./sidebar-workspace-scroll";

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
    return followSidebarWorkspace(`${request.serverId}:${request.workspaceId}`);
  }, [request]);
}
