/**
 * Formats display paths with / separators and replaces the home prefix with ~.
 * Handles the conventional macOS, Linux and Windows user home locations.
 */
export function shortenPath(path: string | undefined | null): string {
  if (!path) {
    return "";
  }
  const normalized = path.replaceAll("\\", "/");
  const windowsHome = normalized.match(/^[a-z]:\/Users\/([^/]+)(?=\/|$)/i);
  if (windowsHome) {
    if (/^(?:Public|Default|Default User|All Users)$/i.test(windowsHome[1])) return normalized;
    return ("~" + normalized.slice(windowsHome[0].length)).replace(
      /^~\/Desktop(?=\/|$)/i,
      "Desktop",
    );
  }
  return normalized.replace(/^\/(?:Users|home)\/[^/]+|^\/root(?=\/|$)/, "~");
}
