import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useHostMutations } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import type { HostProfile } from "@/types/host-connection";

export function HostTerminalSettings({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const { setHostTerminalDirectory } = useHostMutations();
  const directory = host.terminalDirectory?.trim() || "/";
  const openEditor = useCallback(() => setEditing(true), []);
  const closeEditor = useCallback(() => setEditing(false), []);
  const saveDirectory = useCallback(
    (value: string) => setHostTerminalDirectory(host.serverId, value),
    [host.serverId, setHostTerminalDirectory],
  );
  return (
    <SettingsSection title={t("sidebar.terminal.section")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("sidebar.terminal.directory")}</Text>
            <Text style={settingsStyles.rowHint}>{directory}</Text>
          </View>
          <Button
            variant="secondary"
            size="sm"
            onPress={openEditor}
            testID="host-terminal-directory-edit"
          >
            {t("common.actions.edit")}
          </Button>
        </View>
      </View>
      <AdaptiveRenameModal
        visible={editing}
        title={t("sidebar.terminal.directory")}
        initialValue={directory}
        placeholder="/"
        onClose={closeEditor}
        onSubmit={saveDirectory}
        testID="host-terminal-directory-modal"
      />
    </SettingsSection>
  );
}
