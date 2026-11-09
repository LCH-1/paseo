import { getDesktopHost, type DesktopProjectWindowScope } from "@/desktop/host";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";

export function getProjectWindowScope(): DesktopProjectWindowScope | null {
  return getDesktopHost()?.projectWindow ?? null;
}

export function filterProjectWindowHosts<T extends { serverId: string }>(
  hosts: T[],
  scope = getProjectWindowScope(),
): T[] {
  return scope ? hosts.filter((host) => host.serverId === scope.serverId) : hosts;
}

const WINDOW_STORAGE_KEYS = new Set([
  "paseo-drafts",
  "panel-state",
  "sidebar-order",
  "sidebar-project-workspace-order",
  "sidebar-view",
  "sidebar-group-mode",
  "sidebar-collapsed-sections",
  "workspace-layout-state",
  "workspace-tab-groups",
  "paseo:last-workspace-route-selection",
]);

export function projectWindowStorageKey(name: string, scope = getProjectWindowScope()): string {
  if (!scope || !WINDOW_STORAGE_KEYS.has(name)) return name;
  return `paseo-project-window:${scope.windowId}:${name}`;
}

export function filterProjectWindowProjects(
  projects: WorkspaceStructureProject[],
  scope = getProjectWindowScope(),
): WorkspaceStructureProject[] {
  if (!scope) return projects;
  return projects.flatMap((project) => {
    const hosts = project.hosts.filter(
      (host) => host.serverId === scope.serverId && host.projectId === scope.projectId,
    );
    if (!hosts.length) return [];
    return [
      {
        ...project,
        hosts,
        workspaceKeys: project.workspaceKeys.filter((key) => key.startsWith(`${scope.serverId}:`)),
      },
    ];
  });
}

export function isProjectWindowWorkspace(
  serverId: string,
  workspace: { projectId: string } | null | undefined,
  scope = getProjectWindowScope(),
): boolean {
  return !scope || (serverId === scope.serverId && workspace?.projectId === scope.projectId);
}
