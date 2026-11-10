import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  type HostRuntimeConnectionStatus,
  useHostRuntimeDisplayConnectionStatus,
} from "@/runtime/host-runtime";

export function HostStatusDot({ serverId }: { serverId: string }) {
  const status = useHostRuntimeDisplayConnectionStatus(serverId);

  return <View accessibilityLabel={status} style={[styles.dot, statusStyle(status)]} />;
}

function statusStyle(status: HostRuntimeConnectionStatus) {
  if (status === "online") return styles.dotOnline;
  if (status === "connecting") return styles.dotConnecting;
  if (status === "idle") return styles.dotIdle;
  return styles.dotOffline;
}

const styles = StyleSheet.create((theme) => ({
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  dotOnline: {
    backgroundColor: theme.colors.statusSuccess,
  },
  dotIdle: { backgroundColor: theme.colors.foregroundMuted },
  dotConnecting: {
    backgroundColor: theme.colors.statusWarning,
  },
  dotOffline: {
    backgroundColor: theme.colors.statusDanger,
  },
}));
