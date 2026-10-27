import { useCallback, useRef } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SquareTerminal } from "lucide-react-native";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DensityIcon } from "@/components/ui/density-icon";
import { useToast } from "@/contexts/toast-context";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { openDirectoryTerminal } from "@/screens/new-workspace-terminal";
import {
  buildTerminalsQueryKey,
  upsertCreatedTerminalPayload,
  type ListTerminalsPayload,
} from "@/screens/workspace/terminals/state";

const terminalIcon = <DensityIcon icon={SquareTerminal} size="sm" color="foregroundMuted" />;

export function SidebarTerminalMenuItem({
  serverId,
  directory,
  projectId,
  surface = "context",
  testID,
}: {
  serverId: string;
  directory: string;
  projectId?: string;
  surface?: "context" | "dropdown";
  testID: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const hydrated = useSessionStore(
    (state) => state.sessions[serverId]?.hasHydratedWorkspaces === true,
  );
  const inFlight = useRef(false);
  const mutationKey = ["sidebar-terminal", serverId, directory];
  const isPending = useIsMutating({ mutationKey }) > 0;
  const mutation = useMutation({
    mutationKey,
    mutationFn: async () => {
      if (!client || !isConnected) throw new Error(t("workspace.terminal.hostDisconnected"));
      await openDirectoryTerminal({
        serverId,
        directory,
        title: t("workspace.tabs.fallback.terminal"),
        projectId,
        client,
        acceptWorkspace: (workspace) =>
          getHostRuntimeStore().acceptWorkspaceSnapshots(serverId, [workspace]),
        onTerminalCreated: (workspace, terminal) => {
          const queryKey = buildTerminalsQueryKey(
            serverId,
            workspace.workspaceDirectory,
            workspace.id,
          );
          queryClient.setQueryData<ListTerminalsPayload>(queryKey, (current) =>
            upsertCreatedTerminalPayload({
              current,
              terminal,
              workspaceDirectory: workspace.workspaceDirectory,
            }),
          );
        },
        navigate: (targetServerId, workspaceId, target) =>
          navigateToWorkspace({ serverId: targetServerId, workspaceId, target }),
      });
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const openTerminal = useCallback(() => {
    if (inFlight.current || isPending) return;
    inFlight.current = true;
    mutation.mutate();
  }, [isPending, mutation]);
  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  return (
    <Item
      testID={testID}
      leading={terminalIcon}
      disabled={!isConnected || !hydrated || isPending}
      status={mutation.isPending ? "pending" : "idle"}
      pendingLabel={t("sidebar.terminal.opening")}
      onSelect={openTerminal}
    >
      {t("sidebar.terminal.open")}
    </Item>
  );
}
