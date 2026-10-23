import type { PluginAgentTabTitleContext } from "@getpaseo/plugin/client";
import { useSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import { useInstalledPlugins } from "../registry";
import { resolveAgentTabTitle, selectAgentTabSidebarLabel } from "./resolve";

export function useAgentTabTitle(
  context: Omit<PluginAgentTabTitleContext, "sidebarLabel">,
): string | null {
  const installations = useInstalledPlugins();
  const { settings } = useSettings();
  const sidebarLabel = useSessionStore((state) =>
    selectAgentTabSidebarLabel({
      session: state.sessions[context.serverId],
      context,
      workspaceTitleSource: settings.workspaceTitleSource,
    }),
  );
  if (sidebarLabel === null) return null;
  return resolveAgentTabTitle(installations, { ...context, sidebarLabel });
}
