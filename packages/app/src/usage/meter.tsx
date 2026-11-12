import { useMemo } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { clampPct } from "./format";
import type { UsageDisplayAs } from "./preferences";
import type { UsageTone } from "./types";

/** The sidebar meters' normal used share, over a gray track for the remaining capacity. */
export const USAGE_USED_COLOR = "#91b89c";

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
  /** Sidebar input unit; the filled share always represents how much was used. */
  displayAs?: UsageDisplayAs;
  style?: StyleProp<ViewStyle>;
}) {
  const fillWidth = clampPct(displayAs === "remaining" ? 100 - percent : percent);
  const fillStyle = useMemo<StyleProp<ViewStyle>>(() => {
    let color = quiet ? styles.fillQuiet : fillToneStyle(tone);
    if (displayAs)
      color = tone === "warning" || tone === "danger" ? fillToneStyle(tone) : styles.fillUsed;
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
  fillUsed: { backgroundColor: USAGE_USED_COLOR },
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
