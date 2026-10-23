import type { PluginAgentTabTitleContext, PluginAgentTabTitleResult } from "@getpaseo/plugin/client";
import { useSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import { useInstalledPlugins } from "../registry";
import { resolveAgentTabTitle, selectAgentTabProjectLabel, selectAgentTabSidebarLabel } from "./resolve";

export function useAgentTabTitle(
  context: Omit<PluginAgentTabTitleContext, "sidebarLabel" | "projectLabel">,
): PluginAgentTabTitleResult {
  const installations = useInstalledPlugins();
  const { settings } = useSettings();
  const sidebarLabel = useSessionStore((state) =>
    selectAgentTabSidebarLabel({
      session: state.sessions[context.serverId],
      context,
      workspaceTitleSource: settings.workspaceTitleSource,
    }),
  );
  const projectLabel = useSessionStore((state) =>
    selectAgentTabProjectLabel({ session: state.sessions[context.serverId], context }),
  );
  if (sidebarLabel === null) return null;
  return resolveAgentTabTitle(installations, { ...context, sidebarLabel, projectLabel });
}
