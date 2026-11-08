import { useCallback } from "react";
import { View, type ViewStyle } from "react-native";
import { useProviderIcon } from "@/components/provider-icons";
import { DensityIcon } from "@/components/ui/density-icon";
import { useSessionStore } from "@/stores/session-store";

export function WorkspaceProviderIcon({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  // Use the same representative root conversation as the workspace status, without
  // scanning every conversation or subscribing to message content for each row.
  const provider = useSessionStore(
    useCallback(
      (state) => {
        const session = state.sessions[serverId];
        const activity = session?.workspaceAgentActivity.get(workspaceId);
        return activity ? session?.agents.get(activity.agentId)?.provider : undefined;
      },
      [serverId, workspaceId],
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
