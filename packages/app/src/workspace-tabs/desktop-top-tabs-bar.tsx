import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { SidebarMenuToggle } from "@/components/headers/sidebar-menu-toggle";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { NewWorkspaceTabsBar } from "@/workspace-tabs/new-workspace-tabs";

/**
 * Desktop screens outside a workspace have no header: the shared tab row is the window top, like
 * the workspace screen. The empty strip before the toggle keeps a place to grab the window.
 */
export function DesktopTopTabsBar() {
  return (
    <WindowChromeSafeArea placement="inline" style={styles.desktopTabs}>
      <TitlebarDragRegion />
      <View style={styles.desktopTabsFill}>
        <NewWorkspaceTabsBar />
      </View>
      <View style={styles.desktopTabsDragSpace} />
      <SidebarMenuToggle />
    </WindowChromeSafeArea>
  );
}

const styles = StyleSheet.create({
  desktopTabs: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
  },
  desktopTabsFill: {
    flex: 1,
    minWidth: 0,
  },
  desktopTabsDragSpace: {
    width: 46,
    alignSelf: "stretch",
  },
});
