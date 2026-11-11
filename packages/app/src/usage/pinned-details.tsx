import { useCallback, useMemo, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { UsageMeter } from "./meter";
import type { DetailedPinnedUsageWindow, PinnedUsageAccount, PinnedUsageProvider } from "./pinned";
import type { UsageDisplayAs } from "./preferences";
import { UsageSourceIcon } from "./source-icon";
import type { UsageTone } from "./types";

/** Room for a row's name, meter, percent and reset time; past it only an account's name gives way. */
export const PINNED_USAGE_DETAILS_MAX_WIDTH = 480;
const ICON_SIZE = 14;

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
      <UsageLegend />
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

function UsageLegend() {
  return (
    <View style={styles.legend}>
      <View style={styles.legendItem}>
        <View style={[styles.swatch, styles.used]} />
        <Text style={styles.legendText}>사용량</Text>
      </View>
      <View style={styles.legendItem}>
        <View style={[styles.swatch, styles.remaining]} />
        <Text style={styles.legendText}>남은 양</Text>
      </View>
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
        <UsageSourceIcon svg={provider.icon} size={ICON_SIZE} />
        <Text style={styles.providerName} numberOfLines={1}>
          {provider.label}
        </Text>
      </View>
      {provider.accounts.map((account) => (
        <AccountDetails
          key={account.key}
          account={account}
          columns={columns}
          displayAs={displayAs}
        />
      ))}
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
        {detail.percentLabel}
      </Text>
      {detail.reset ? (
        <Text style={styles.reset} numberOfLines={1}>
          {detail.reset}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  details: {
    gap: theme.spacing[2],
  },
  legend: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  legendItem: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  // A step under the card's text: the legend explains the meters and is not itself a row.
  legendText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm - 1,
  },
  swatch: { width: 6, height: 6, borderRadius: 1 },
  // The sidebar meters' colours.
  used: { backgroundColor: theme.colors.surface3 },
  remaining: { backgroundColor: "#91b89c" },
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
  // Accounts start on the provider name's rail, past its icon.
  account: {
    gap: theme.spacing[1],
    paddingLeft: ICON_SIZE + theme.spacing[1.5],
  },
  accountName: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  windowRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  windowName: {
    flexShrink: 0,
    color: theme.colors.popoverForeground,
    fontSize: theme.fontSize.sm,
  },
  meter: {
    width: 56,
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
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
