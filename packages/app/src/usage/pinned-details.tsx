import { useCallback, useMemo, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ICON_SIZE } from "@/styles/theme";
import { UsageMeter } from "./meter";
import type {
  DetailedPinnedUsageWindow,
  PinnedUsageAccount,
  PinnedUsageProvider,
  PinnedUsageReset,
} from "./pinned";
import type { UsageDisplayAs } from "./preferences";
import { UsageSourceIcon } from "./source-icon";
import type { UsageTone } from "./types";

/** Keep the card within a normal sidebar while showing its reset date and countdown. */
export const PINNED_USAGE_DETAILS_MAX_WIDTH = 600;
// A long window name ("5시간 · GPT-5.3-Codex-Spark") gives way here, keeping its period, so the
// name column it widens for every row never takes the reset time's room.
const WINDOW_NAME_MAX_WIDTH = 104;

interface DetailColumn {
  style: { minWidth: number };
  onLayout: (event: LayoutChangeEvent) => void;
}

interface DetailColumns {
  name: DetailColumn;
  percent: DetailColumn;
}

/**
 * A column every row of the card shares: each cell spans the widest cell laid out so far, so the
 * next column starts on one rail across every account and provider.
 */
function useDetailColumn(): DetailColumn {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.ceil(event.nativeEvent.layout.width);
    setWidth((widest) => Math.max(widest, measured));
  }, []);
  return useMemo(() => ({ style: { minWidth: width }, onLayout }), [onLayout, width]);
}

/**
 * The sidebar Usage item's hover card: what the meter colours mean, then each provider under its
 * icon and name, each account's name, and a row per window with its name, meter, percent and
 * reset time.
 */
export function PinnedUsageDetails({
  providers,
  displayAs,
}: {
  providers: readonly PinnedUsageProvider[];
  displayAs: UsageDisplayAs;
}) {
  const name = useDetailColumn();
  const percent = useDetailColumn();
  const columns = useMemo<DetailColumns>(() => ({ name, percent }), [name, percent]);
  return (
    <View style={styles.details}>
      {providers.map((provider, index) => (
        <ProviderDetails
          key={provider.key}
          provider={provider}
          divided={index > 0}
          columns={columns}
          displayAs={displayAs}
        />
      ))}
    </View>
  );
}

function ProviderDetails({
  provider,
  divided,
  columns,
  displayAs,
}: {
  provider: PinnedUsageProvider;
  divided: boolean;
  columns: DetailColumns;
  displayAs: UsageDisplayAs;
}) {
  return (
    <View
      style={divided ? [styles.provider, styles.providerDivided] : styles.provider}
      testID="sidebar-usage-detail-provider"
    >
      <View style={styles.providerHeader}>
        <UsageSourceIcon svg={provider.icon} size={ICON_SIZE.sm} />
        <Text style={styles.providerName} numberOfLines={1}>
          {provider.label}
        </Text>
      </View>
      <View style={styles.accounts}>
        {provider.accounts.map((account) => (
          <AccountDetails
            key={account.key}
            account={account}
            columns={columns}
            displayAs={displayAs}
          />
        ))}
      </View>
    </View>
  );
}

function AccountDetails({
  account,
  columns,
  displayAs,
}: {
  account: PinnedUsageAccount;
  columns: DetailColumns;
  displayAs: UsageDisplayAs;
}) {
  return (
    <View style={styles.account} testID="sidebar-usage-detail-account">
      {account.label ? (
        <Text style={styles.accountName} numberOfLines={1}>
          {account.label}
        </Text>
      ) : null}
      {account.windows.map((window) => (
        <WindowDetailRow key={window.key} window={window} columns={columns} displayAs={displayAs} />
      ))}
    </View>
  );
}

function percentToneStyle(tone: UsageTone) {
  if (tone === "danger") return styles.percentDanger;
  if (tone === "warning") return styles.percentWarning;
  return undefined;
}

function WindowDetailRow({
  window,
  columns,
  displayAs,
}: {
  window: DetailedPinnedUsageWindow;
  columns: DetailColumns;
  displayAs: UsageDisplayAs;
}) {
  const { detail } = window;
  return (
    <View style={styles.windowRow} testID="sidebar-usage-detail-row">
      <Text
        style={[styles.windowName, columns.name.style]}
        onLayout={columns.name.onLayout}
        numberOfLines={1}
      >
        {detail.name}
      </Text>
      <UsageMeter
        percent={window.percent}
        tone={window.tone}
        displayAs={displayAs}
        style={styles.meter}
      />
      <Text
        style={[styles.percent, percentToneStyle(window.tone), columns.percent.style]}
        onLayout={columns.percent.onLayout}
      >
        {window.percentText}
      </Text>
      {detail.reset ? <ResetDetail reset={detail.reset} /> : null}
    </View>
  );
}

/** A short local date and countdown, with the full timestamp accessible. */
function ResetDetail({ reset }: { reset: PinnedUsageReset }) {
  return (
    <View style={styles.reset} accessibilityLabel={reset.at} testID="sidebar-usage-detail-reset">
      <Text style={styles.resetAt} numberOfLines={1}>
        {reset.compactAt}
      </Text>
      <Text style={styles.resetRelative} numberOfLines={1}>
        · {reset.relative}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  details: {
    gap: theme.spacing[2],
  },
  provider: {
    gap: theme.spacing[1.5],
  },
  // The card's own outline colour: `border` disappears into the dark popover surface.
  providerDivided: {
    paddingTop: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.borderAccent,
  },
  providerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  providerName: {
    flexShrink: 1,
    color: theme.colors.popoverForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  // Accounts sit further apart than an account's own rows, so each reads as one group.
  accounts: {
    gap: theme.spacing[3],
  },
  // Account text and rows share the card's leading edge, without a reserved icon gutter.
  account: {
    gap: theme.spacing[1],
  },
  accountName: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  windowRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  // Names are the rows' context; the percent and the time to reset carry the values.
  windowName: {
    flexShrink: 0,
    maxWidth: WINDOW_NAME_MAX_WIDTH,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  meter: {
    flex: 1,
    minWidth: 44,
    height: 6,
    borderRadius: 3,
  },
  percent: {
    flexShrink: 0,
    textAlign: "right",
    color: theme.colors.popoverForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  percentWarning: { color: theme.colors.statusWarning },
  percentDanger: { color: theme.colors.statusDanger },
  reset: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  resetAt: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  resetRelative: {
    flexShrink: 0,
    color: theme.colors.popoverForeground,
    fontSize: theme.fontSize.sm,
  },
}));
