import { createContext, useCallback, useContext, useState, type PropsWithChildren } from "react";
import { useTranslation } from "react-i18next";
import { FolderCog } from "lucide-react-native";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DensityIcon } from "@/components/ui/density-icon";
import { useHostMutations, useHosts } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";

const OpenDirectoryEditorContext = createContext<((serverId: string) => void) | null>(null);
const directoryIcon = <DensityIcon icon={FolderCog} size="sm" color="foregroundMuted" />;

export function HostTerminalDirectoryProvider({ children }: PropsWithChildren) {
  const [serverId, setServerId] = useState<string | null>(null);
  const hosts = useHosts();
  const host = hosts.find((entry) => entry.serverId === serverId);
  const closeEditor = useCallback(() => setServerId(null), []);
  return (
    <OpenDirectoryEditorContext.Provider value={setServerId}>
      {children}
      {host ? <HostTerminalDirectoryModal host={host} onClose={closeEditor} /> : null}
    </OpenDirectoryEditorContext.Provider>
  );
}

function HostTerminalDirectoryModal({ host, onClose }: { host: HostProfile; onClose: () => void }) {
  const { t } = useTranslation();
  const { setHostTerminalDirectory } = useHostMutations();
  const directory = host.terminalDirectory?.trim() || "/";
  const saveDirectory = useCallback(
    (value: string) => setHostTerminalDirectory(host.serverId, value),
    [host.serverId, setHostTerminalDirectory],
  );
  return (
    <AdaptiveRenameModal
      visible
      title={t("sidebar.terminal.directory")}
      initialValue={directory}
      placeholder="/"
      onClose={onClose}
      onSubmit={saveDirectory}
      testID="host-terminal-directory-modal"
    />
  );
}

export function HostTerminalDirectoryMenuItem({
  serverId,
  surface = "context",
  testID,
}: {
  serverId: string;
  surface?: "context" | "dropdown";
  testID: string;
}) {
  const { t } = useTranslation();
  const openEditor = useContext(OpenDirectoryEditorContext);
  const editDirectory = useCallback(() => {
    if (!openEditor) throw new Error("HostTerminalDirectoryProvider is required");
    openEditor(serverId);
  }, [openEditor, serverId]);
  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  return (
    <Item testID={testID} leading={directoryIcon} onSelect={editDirectory}>
      {t("sidebar.terminal.configureDirectory")}
    </Item>
  );
}
