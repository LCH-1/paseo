import { useMemo } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { clampPct } from "./format";
import type { UsageDisplayAs } from "./preferences";
import type { UsageTone } from "./types";

/** The sidebar meters' fill for the share left, over a `surface3` track for the share used. */
export const USAGE_REMAINING_COLOR = "#91b89c";

function fillToneStyle(tone: UsageTone) {
  switch (tone) {
    case "ok":
      return styles.fillOk;
    case "warning":
      return styles.fillWarning;
    case "danger":
      return styles.fillDanger;
    default:
      return styles.fillDefault;
  }
}

/**
 * A window's share as a bar, coloured by its tone. `quiet` fills it with a surface colour instead,
 * for summaries where a row of coloured bars would be noise. The caller sizes the track.
 */
export function UsageMeter({
  percent,
  tone,
  quiet = false,
  displayAs,
  style,
}: {
  percent: number;
  tone: UsageTone;
  quiet?: boolean;
  /** Sidebar bars fill the remaining share over a gray track in either input mode. */
  displayAs?: UsageDisplayAs;
  style?: StyleProp<ViewStyle>;
}) {
  const fillWidth = clampPct(displayAs === "used" ? 100 - percent : percent);
  const fillStyle = useMemo<StyleProp<ViewStyle>>(() => {
    let color = quiet ? styles.fillQuiet : fillToneStyle(tone);
    if (displayAs) color = styles.remaining;
    return [styles.fill, color, { width: `${fillWidth}%` }];
  }, [displayAs, fillWidth, quiet, tone]);
  let trackColor;
  if (displayAs) trackColor = styles.used;
  return (
    <View style={[styles.track, trackColor, style]}>
      <View style={fillStyle} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  // Follows the track, so a caller that sizes the track sizes the bar.
  fill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
  },
  fillQuiet: {
    backgroundColor: theme.colors.surface4,
  },
  used: { backgroundColor: theme.colors.surface3 },
  remaining: { backgroundColor: USAGE_REMAINING_COLOR },
  fillDefault: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  fillOk: {
    backgroundColor: theme.colors.statusSuccess,
  },
  fillWarning: {
    backgroundColor: theme.colors.statusWarning,
  },
  fillDanger: {
    backgroundColor: theme.colors.statusDanger,
  },
}));
