import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react-native";
import { DensityIcon } from "@/components/ui/density-icon";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import {
  sidebarHostGroupKey,
  sidebarHostProjectKey,
  type SidebarHostProjectGroup,
} from "./host-project-groups";
import { useSidebarModel } from "./sidebar-model";

export function SidebarCollapseAllHostsButton() {
  const { t } = useTranslation();
  const { groupMode, hostGroups } = useSidebarModel();
  const keys = useMemo(
    () => hostGroups.map((group) => sidebarHostGroupKey(group.serverId)),
    [hostGroups],
  );
  const allCollapsed = useSidebarCollapsedSectionsStore(
    (state) => keys.length > 0 && keys.every((key) => state.collapsedWorkspaceGroupKeys.has(key)),
  );
  const setWorkspaceGroupsCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.setWorkspaceGroupsCollapsed,
  );
  const handlePress = useCallback(
    () => setWorkspaceGroupsCollapsed(keys, !allCollapsed),
    [allCollapsed, keys, setWorkspaceGroupsCollapsed],
  );
  const label = t(
    allCollapsed ? "sidebar.actions.expandAllHosts" : "sidebar.actions.collapseAllHosts",
  );
  const icon = allCollapsed ? ChevronsUpDown : ChevronsDownUp;

  if (groupMode !== "host") return null;

  return (
    <ToolbarButton
      compact
      label={label}
      disabled={keys.length === 0}
      onPress={handlePress}
      testID="sidebar-collapse-all-hosts"
    >
      <DensityIcon icon={icon} size="xs" color="foregroundMuted" />
    </ToolbarButton>
  );
}

export function SidebarCollapseHostProjectsButton({ group }: { group: SidebarHostProjectGroup }) {
  const { t } = useTranslation();
  const keys = useMemo(
    () =>
      group.projects.map((project) =>
        sidebarHostProjectKey({ serverId: group.serverId, projectViewKey: project.viewKey }),
      ),
    [group],
  );
  const allCollapsed = useSidebarCollapsedSectionsStore(
    (state) => keys.length > 0 && keys.every((key) => state.collapsedProjectKeys.has(key)),
  );
  const hostCollapsed = useSidebarCollapsedSectionsStore((state) =>
    state.collapsedWorkspaceGroupKeys.has(sidebarHostGroupKey(group.serverId)),
  );
  const setProjectsCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.setProjectsCollapsed,
  );
  const handlePress = useCallback(
    () => setProjectsCollapsed(keys, !allCollapsed),
    [allCollapsed, keys, setProjectsCollapsed],
  );
  const label = t(
    allCollapsed ? "sidebar.actions.expandHostProjects" : "sidebar.actions.collapseHostProjects",
  );
  const icon = allCollapsed ? ChevronsUpDown : ChevronsDownUp;
  const disabled = hostCollapsed || keys.length === 0;

  return (
    <ToolbarButton
      compact
      label={label}
      disabled={disabled}
      onPress={handlePress}
      testID={`sidebar-collapse-host-projects-${group.serverId}`}
    >
      <DensityIcon icon={icon} size="xs" color="foregroundMuted" />
    </ToolbarButton>
  );
}
