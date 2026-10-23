import React, { type ComponentProps } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { WorkspaceTabPresentation } from "./workspace-tab-presentation";

export function resolveWorkspaceTabTitleLines(
  presentation: Pick<WorkspaceTabPresentation, "kind" | "titleState" | "titleLines">,
): WorkspaceTabPresentation["titleLines"] {
  return presentation.titleState === "ready" &&
    (presentation.kind === "agent" || presentation.kind === "provider_subagent")
    ? presentation.titleLines
    : undefined;
}

export function workspaceTabTitleSignature(
  label: string,
  titleLines: WorkspaceTabPresentation["titleLines"],
  isPreview = false,
): string {
  return JSON.stringify([label, titleLines?.primaryLabel, titleLines?.secondaryLabel, isPreview]);
}

export function WorkspaceTabTitle({
  label,
  titleLines,
  labelStyle,
  isPreview = false,
  measurement = false,
  onLayout,
}: {
  label: string;
  titleLines?: WorkspaceTabPresentation["titleLines"];
  labelStyle: ComponentProps<typeof Text>["style"];
  isPreview?: boolean;
  measurement?: boolean;
  onLayout?: ComponentProps<typeof View>["onLayout"];
}) {
  const fontStyle = isPreview ? styles.preview : styles.pinned;
  if (!titleLines) {
    return (
      <Text
        style={[labelStyle, fontStyle, measurement && styles.measurement]}
        selectable={false}
        numberOfLines={1}
        ellipsizeMode="tail"
        onLayout={onLayout}
      >
        {label}
      </Text>
    );
  }

  return (
    <View style={measurement ? styles.measurementLines : styles.lines} onLayout={onLayout}>
      <Text
        testID={measurement ? undefined : "agent-tab-title-line-primary"}
        style={[labelStyle, styles.primary, fontStyle, measurement && styles.measurement]}
        selectable={false}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {titleLines.primaryLabel}
      </Text>
      <Text
        testID={measurement ? undefined : "agent-tab-title-line-secondary"}
        style={[labelStyle, styles.secondary, fontStyle, measurement && styles.measurement]}
        selectable={false}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {titleLines.secondaryLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  preview: {
    fontStyle: "italic",
  },
  pinned: {
    fontStyle: "normal",
  },
  lines: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "column",
    justifyContent: "center",
  },
  primary: {
    fontSize: 10,
    lineHeight: 11,
    color: theme.colors.foregroundMuted,
  },
  secondary: {
    fontSize: theme.fontSize.base,
    lineHeight: 14,
  },
  measurement: {
    flexShrink: 0,
  },
  measurementLines: {
    flexShrink: 0,
    flexDirection: "column",
    alignItems: "flex-start",
  },
}));
