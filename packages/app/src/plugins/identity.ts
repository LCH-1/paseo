import type { InstalledPlugin } from "./types";

/** Exact installations win while hosts are being migrated independently. */
export function findPluginById(
  plugins: readonly InstalledPlugin[],
  serverId: string,
  id: string,
): InstalledPlugin | null {
  const exact = plugins.find((plugin) => plugin.serverId === serverId && plugin.id === id);
  if (exact) return exact;
  const aliases = plugins.filter(
    (plugin) => plugin.serverId === serverId && plugin.legacyIds?.includes(id),
  );
  return aliases.length === 1 ? aliases[0] : null;
}

export function matchesPluginId(plugin: InstalledPlugin, id: string): boolean {
  return plugin.id === id || plugin.legacyIds?.includes(id) === true;
}
