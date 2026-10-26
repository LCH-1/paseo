import React, { type ComponentProps } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { WorkspaceTabPresentation } from "./workspace-tab-presentation";
import { useCompletionTimeAgo } from "@/hooks/use-time-ago";

function AgentTabCompletionAge({ completedAt }: { completedAt: number }) {
  const date = new Date(completedAt);
  const label = useCompletionTimeAgo(date);
  return (
    <Text
      testID="agent-tab-completion-age"
      style={styles.completionAge}
      selectable={false}
      accessibilityLabel={`작업 완료 ${date.toLocaleString()}, ${label} 경과`}
      dataSet={{ completedAt: date.toISOString() }}
    >
      {label}
    </Text>
  );
}

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
  return JSON.stringify([
    label,
    titleLines?.primaryLabel,
    titleLines?.secondaryLabel,
    isPreview,
    titleLines?.completedAt != null,
  ]);
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
      <View style={styles.primaryRow}>
        <Text
          testID={measurement ? undefined : "agent-tab-title-line-primary"}
          style={[
            labelStyle,
            styles.primary,
            styles.projectLabel,
            fontStyle,
            measurement && styles.measurement,
          ]}
          selectable={false}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {titleLines.primaryLabel}
        </Text>
        {titleLines.completedAt != null ? (
          measurement ? (
            <Text style={styles.completionAge}>00m</Text>
          ) : (
            <AgentTabCompletionAge completedAt={titleLines.completedAt} />
          )
        ) : null}
      </View>
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
  primaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  projectLabel: {
    flexShrink: 1,
    minWidth: 0,
  },
  completionAge: {
    flexShrink: 0,
    width: 30,
    fontSize: 10,
    lineHeight: 11,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
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
