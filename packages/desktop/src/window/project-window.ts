import { randomUUID } from "node:crypto";

export interface ProjectWindowTarget {
  serverId: string;
  projectId: string;
  projectName: string;
  directory: string;
}

export interface ProjectWindowScope extends ProjectWindowTarget {
  windowId: string;
}

export function readNotificationProject(
  data: Record<string, unknown> | undefined,
): ProjectWindowTarget | null {
  if (!data?.projectWindow) return null;
  try {
    const project = parseProjectWindowTarget(data.projectWindow);
    return project.serverId === data.serverId ? project : null;
  } catch {
    return null;
  }
}

export function selectNotificationWindow<
  T extends {
    id: number;
    projectWindow: ProjectWindowTarget | null;
  },
>(windows: T[], senderId: number | undefined, target: ProjectWindowTarget | null): T | null {
  const candidates = windows.filter((win) =>
    target
      ? win.projectWindow?.serverId === target.serverId &&
        win.projectWindow.projectId === target.projectId
      : win.projectWindow === null,
  );
  return candidates.find((win) => win.id === senderId) ?? candidates[0] ?? null;
}

export function resolveProjectWindowTitle(
  scope: ProjectWindowScope,
  pageTitle: string,
  appName: string,
): string {
  const title = pageTitle.trim();
  if (!title || title === appName || title === "Paseo" || title === "Workspace") {
    return `${scope.projectName} · ${appName}`;
  }
  return pageTitle;
}

export function parseProjectWindowTarget(value: unknown): ProjectWindowTarget {
  if (!value || typeof value !== "object") throw new Error("Invalid project window target");
  const fields = ["serverId", "projectId", "projectName", "directory"] as const;
  const result = { serverId: "", projectId: "", projectName: "", directory: "" };
  for (const field of fields) {
    const entry = Reflect.get(value, field);
    if (typeof entry !== "string" || !entry.trim() || entry.length > 8192) {
      throw new Error(`Invalid project window ${field}`);
    }
    result[field] = entry;
  }
  return result;
}

export function createProjectWindowScope(value: unknown): ProjectWindowScope {
  return { ...parseProjectWindowTarget(value), windowId: randomUUID() };
}

export function projectWindowRoute(scope: ProjectWindowScope): string {
  const query = new URLSearchParams({
    serverId: scope.serverId,
    projectId: scope.projectId,
    dir: scope.directory,
    name: scope.projectName,
  });
  return `/new?${query}`;
}

export function projectWindowArgument(scope: ProjectWindowScope): string {
  return `--paseo-project-window=${encodeURIComponent(JSON.stringify(scope))}`;
}
