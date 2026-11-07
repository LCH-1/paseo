import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../types";
import { listSidebarPluginScreens, selectedPluginScreenSection } from "./sidebar";

function plugin(serverId: string, id: string, screens: object[]) {
  return { serverId, id, settingsScreens: screens } as unknown as InstalledPlugin;
}

const screen = (id: string, showInSettingsSidebar?: boolean) => ({
  id,
  title: `title ${id}`,
  icon: "Users",
  Component: () => null,
  showInSettingsSidebar,
});

describe("settings sidebar plugin screens", () => {
  const plugins = [
    plugin("a", "aster", [screen("accounts", true), screen("other")]),
    plugin("b", "aster", [screen("accounts", true)]),
    plugin("a", "sync", [screen("main")]),
  ];

  it("lists only pinned screens of the chosen host", () => {
    expect(listSidebarPluginScreens(plugins, "a").map((item) => item.key)).toEqual([
      "plugin:aster/accounts",
    ]);
    expect(listSidebarPluginScreens(plugins, null)).toEqual([]);
  });

  it("selects the pinned row, and leaves other plugin screens under Plugins", () => {
    expect(
      selectedPluginScreenSection({ serverId: "a", pluginId: "aster", screenId: "accounts" }, plugins),
    ).toBe("plugin:aster/accounts");
    expect(
      selectedPluginScreenSection({ serverId: "a", pluginId: "aster", screenId: "other" }, plugins),
    ).toBe("plugins");
  });
});
