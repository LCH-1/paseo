/**
 * Shortens a file path by replacing the home directory prefix with ~.
 * Handles the conventional macOS, Linux and Windows user home locations.
 */
export function shortenPath(path: string | undefined | null): string {
  if (!path) {
    return "";
  }
  const windowsHome = path.match(/^[a-z]:[\\/]Users[\\/]([^\\/]+)(?=[\\/]|$)/i);
  if (windowsHome) {
    if (/^(?:Public|Default|Default User|All Users)$/i.test(windowsHome[1])) return path;
    return "~" + path.slice(windowsHome[0].length);
  }
  return path.replace(/^\/(?:Users|home)\/[^/]+|^\/root(?=\/|$)/, "~");
}
