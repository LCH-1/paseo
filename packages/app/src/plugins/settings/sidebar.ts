import type { InstalledPlugin } from "../types";

export interface SidebarPluginScreen {
  key: string;
  serverId: string;
  pluginId: string;
  screenId: string;
  title: string;
  icon: string;
}

function sidebarPluginScreenKey(pluginId: string, screenId: string) {
  return `plugin:${pluginId}/${screenId}`;
}

/** Plugin settings screens that asked for a row of their own in the settings sidebar. */
export function listSidebarPluginScreens(
  plugins: readonly InstalledPlugin[],
  serverId: string | null,
): SidebarPluginScreen[] {
  return plugins
    .filter((plugin) => plugin.serverId === serverId)
    .flatMap((plugin) =>
      plugin.settingsScreens
        .filter((screen) => screen.showInSettingsSidebar)
        .map((screen) => ({
          key: sidebarPluginScreenKey(plugin.id, screen.id),
          serverId: plugin.serverId,
          pluginId: plugin.id,
          screenId: screen.id,
          title: screen.title,
          icon: screen.icon,
        })),
    );
}

/** A pinned screen selects its own row; every other plugin screen stays under "Plugins". */
export function selectedPluginScreenSection(
  view: { serverId: string; pluginId: string; screenId: string },
  plugins: readonly InstalledPlugin[],
): string {
  const pinned = listSidebarPluginScreens(plugins, view.serverId).some(
    (screen) => screen.pluginId === view.pluginId && screen.screenId === view.screenId,
  );
  return pinned ? sidebarPluginScreenKey(view.pluginId, view.screenId) : "plugins";
}
