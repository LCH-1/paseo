import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceStructureHostPlacement } from "@/projects/workspace-structure";

export interface SidebarHostProjectGroup {
  serverId: string;
  projects: SidebarProjectEntry[];
}

export function sidebarHostGroupKey(serverId: string): string {
  return `host:${serverId}`;
}

export function sidebarHostProjectKey(input: { serverId: string; projectViewKey: string }): string {
  return `host-project:${JSON.stringify([input.serverId, input.projectViewKey])}`;
}

export function filterSidebarProjectHosts(input: {
  project: SidebarProjectEntry;
  workspaces: SidebarWorkspacePlacement[];
  keepEmptyProjects: boolean;
}): WorkspaceStructureHostPlacement[] {
  const visibleServerIds = new Set(input.workspaces.map((workspace) => workspace.serverId));
  const originalServerIds = new Set(
    input.project.workspaces.map((workspace) => workspace.serverId),
  );
  return input.project.hosts.filter((host) => {
    if (visibleServerIds.has(host.serverId)) return true;
    return input.keepEmptyProjects && !originalServerIds.has(host.serverId);
  });
}

export function buildSidebarHostProjectGroups(input: {
  projects: SidebarProjectEntry[];
  serverIds: readonly string[];
}): SidebarHostProjectGroup[] {
  const groups: SidebarHostProjectGroup[] = input.serverIds.map((serverId) => ({
    serverId,
    projects: [],
  }));
  const groupsByServerId = new Map(groups.map((group) => [group.serverId, group]));

  for (const project of input.projects) {
    for (const host of project.hosts) {
      const group = groupsByServerId.get(host.serverId);
      if (!group) continue;
      const workspaces = project.workspaces.filter(
        (workspace) => workspace.serverId === host.serverId,
      );
      group.projects.push({
        ...project,
        iconWorkingDir: host.iconWorkingDir,
        hosts: [host],
        workspaces,
      });
    }
  }

  return groups.filter((group) => group.projects.length > 0);
}
