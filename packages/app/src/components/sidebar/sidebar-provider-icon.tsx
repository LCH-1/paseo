import { useCallback } from "react";
import { View, type ViewStyle } from "react-native";
import { useProviderIcon } from "@/components/provider-icons";
import { DensityIcon } from "@/components/ui/density-icon";
import { useSessionStore } from "@/stores/session-store";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { resolveWorkspaceProvider } from "@/utils/workspace-agent-activity";

export function WorkspaceProviderIcon({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const workspaceKey = `${serverId}:${workspaceId}`;
  const selectedAgentId = useWorkspaceLayoutStore(
    useCallback(
      (state) => {
        const sheet = state.sheetsByWorkspace[workspaceKey]?.at(-1)?.tab;
        if (sheet?.target.kind === "agent") return sheet.target.agentId;
        const layout = state.layoutByWorkspace[workspaceKey];
        if (!layout) return null;
        const pane = findPaneById(
          layout.root,
          layout.focusedPaneId ?? state.focusRestorationByWorkspace[workspaceKey]?.restorePaneId,
        );
        if (!pane?.focusedTabId || pane.hidden) return null;
        const tab = collectAllTabs({ kind: "pane", pane }).find(
          (candidate) => candidate.tabId === pane.focusedTabId,
        );
        return tab?.target.kind === "agent" ? tab.target.agentId : null;
      },
      [workspaceKey],
    ),
  );
  // The workspace's latest conversation can use another provider than the one
  // selected in this window. Display that selection without changing its model.
  const provider = useSessionStore(
    useCallback(
      (state) => {
        const session = state.sessions[serverId];
        return resolveWorkspaceProvider({
          serverId,
          workspaceId,
          selectedAgentId,
          agents: session?.agents,
          activity: session?.workspaceAgentActivity.get(workspaceId),
        });
      },
      [serverId, workspaceId, selectedAgentId],
    ),
  );
  return provider ? <SidebarProviderIcon provider={provider} serverId={serverId} /> : null;
}

export function SidebarProviderIcon({
  provider,
  serverId,
}: {
  provider: string;
  serverId: string;
}) {
  const Icon = useProviderIcon(provider, serverId);
  let label = provider;
  if (provider === "claude") label = "Claude";
  else if (provider === "codex") label = "Codex";
  return (
    <View
      style={iconStyle}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      testID="sidebar-provider-icon"
    >
      <DensityIcon icon={Icon} size="xs" color="foregroundMuted" />
    </View>
  );
}

const iconStyle: ViewStyle = {
  flexShrink: 0,
  alignSelf: "center",
  alignItems: "center",
  justifyContent: "center",
};
