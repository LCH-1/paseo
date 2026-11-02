import { isAbsolutePath } from "./path";

interface BuildAbsoluteExplorerPathInput {
  workspaceRoot: string;
  entryPath: string;
}

export function buildAbsoluteExplorerPath({
  workspaceRoot,
  entryPath,
}: BuildAbsoluteExplorerPathInput): string {
  const normalizedWorkspaceRoot = workspaceRoot.trim().replace(/[\\/]+$/, "");
  const normalizedEntryPath = entryPath.trim();

  if (!normalizedWorkspaceRoot) {
    return normalizedEntryPath;
  }

  if (!normalizedEntryPath || normalizedEntryPath === ".") {
    return normalizedWorkspaceRoot;
  }

  if (isAbsolutePath(normalizedEntryPath)) {
    return normalizedEntryPath;
  }

  const separator = normalizedWorkspaceRoot.includes("\\") ? "\\" : "/";
  const segments = normalizedEntryPath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) {
    return normalizedWorkspaceRoot;
  }

  return `${normalizedWorkspaceRoot}${separator}${segments.join(separator)}`;
}

export function parentExplorerPath(entryPath: string): string {
  const separatorIndex = entryPath.lastIndexOf("/");
  return separatorIndex > 0 ? entryPath.slice(0, separatorIndex) : ".";
}

/** Scope an explicitly linked absolute download to its own parent directory. */
export function resolveExplorerDownloadPath(workspaceRoot: string, filePath: string) {
  if (!isAbsolutePath(filePath)) {
    return { cwd: workspaceRoot, path: filePath };
  }

  const normalizedPath = filePath.replace(/\\/g, "/");
  const separatorIndex = normalizedPath.lastIndexOf("/");
  if (separatorIndex < 0 || separatorIndex === normalizedPath.length - 1) {
    return { cwd: workspaceRoot, path: filePath };
  }

  const parent = normalizedPath.slice(0, separatorIndex);
  return {
    cwd: /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent || "/",
    path: normalizedPath.slice(separatorIndex + 1),
  };
}
