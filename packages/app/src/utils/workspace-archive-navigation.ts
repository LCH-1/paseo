import type { Href } from "expo-router";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  buildHostRootRoute,
  buildHostWorkspaceRoute,
  buildNewWorkspaceRoute,
} from "@/utils/host-routes";
import { resolveWorkspaceRouteId } from "@/utils/workspace-identity";

export function buildWorkspaceArchiveRedirectRoute(input: {
  serverId: string;
  archivedWorkspaceId: string;
  workspaces: Iterable<WorkspaceDescriptor>;
}): Href {
  const archivedWorkspaceId = resolveWorkspaceRouteId({
    routeWorkspaceId: input.archivedWorkspaceId,
  });
  if (!archivedWorkspaceId) {
    return buildHostRootRoute(input.serverId);
  }

  const workspaces = Array.from(input.workspaces);
  const archivedWorkspace =
    workspaces.find((workspace) => workspace.id === archivedWorkspaceId) ?? null;
  // Stay in the user's work: the same project first, then anything else still open on this host.
  const remaining = workspaces.filter(
    (workspace) => workspace.id !== archivedWorkspaceId && !workspace.archivingAt,
  );
  const next =
    remaining.find((workspace) => workspace.projectId === archivedWorkspace?.projectId) ??
    remaining[0];
  if (next) {
    return buildHostWorkspaceRoute(input.serverId, next.id);
  }
  const sourceDirectory =
    archivedWorkspace?.projectRootPath || archivedWorkspace?.workspaceDirectory;
  if (!sourceDirectory) {
    return buildHostRootRoute(input.serverId);
  }

  return buildNewWorkspaceRoute({
    serverId: input.serverId,
    sourceDirectory,
    displayName: archivedWorkspace.projectDisplayName,
    projectId: archivedWorkspace.projectId,
  });
}
