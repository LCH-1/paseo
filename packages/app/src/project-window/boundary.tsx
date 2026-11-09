import { Redirect, usePathname } from "expo-router";
import type { ReactNode } from "react";
import { useSessionStore } from "@/stores/session-store";
import { buildNewWorkspaceRoute, parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";
import { getProjectWindowScope, isProjectWindowWorkspace } from "./state";

export function ProjectWindowBoundary({ children }: { children: ReactNode }) {
  const scope = getProjectWindowScope();
  const pathname = usePathname();
  const selection = parseHostWorkspaceRouteFromPathname(pathname);
  const workspace = useSessionStore((state) =>
    selection
      ? state.sessions[selection.serverId]?.workspaces.get(selection.workspaceId)
      : undefined,
  );
  if (!scope) return children;
  const newRoute = buildNewWorkspaceRoute({
    serverId: scope.serverId,
    projectId: scope.projectId,
    sourceDirectory: scope.directory,
    displayName: scope.projectName,
  });
  if (pathname === "/open-project" || pathname.endsWith("/open-project"))
    return <Redirect href={newRoute} />;
  const hostSegment = pathname.split("/")[2];
  if (pathname.startsWith("/h/") && decodeURIComponent(hostSegment) !== scope.serverId) {
    return <Redirect href={newRoute} />;
  }
  if (!selection) return children;
  if (!workspace) return null;
  if (!isProjectWindowWorkspace(selection.serverId, workspace, scope))
    return <Redirect href={newRoute} />;
  return children;
}
