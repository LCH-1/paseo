import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import { useUsagePreferences } from "./display";
import { useUsageHostId } from "./hosts";
import { useUsageHostReports } from "./queries";
import { UsageSourceIcon } from "./source-icon";
import { UsageMeter } from "./meter";
import {
  resolveProviderPinnedUsage,
  type PinnedUsageProvider,
  type PinnedUsageSource,
} from "./pinned";
import { PINNED_USAGE_DETAILS_MAX_WIDTH, PinnedUsageDetails } from "./pinned-details";
import type { UsageDisplayAs } from "./preferences";
import { UsageModal } from "./usage-modal";

/**
 * Each summary window with data on the usage host, under its provider; empty while none has.
 * Reset times count from `now`, or from when the reports or preferences last changed.
 */
function useUsageSummary(now?: number): readonly PinnedUsageProvider[] {
  const { preferences } = useUsagePreferences();
  const reports = useUsageHostReports(useUsageHostId());
  return useMemo(
    () => resolveProviderPinnedUsage(reports, preferences, now),
    [now, preferences, reports],
  );
}

/** Whether the sidebar Usage item has anything to show. */
export function useHasUsageSummary(): boolean {
  return useUsageSummary().length > 0;
}

/**
 * The sidebar footer's usage entry: each summary window's source icon and percent, and nothing
 * while no summary window has data, since the footer's Usage icon already opens Usage.
 * Pressing it opens the Usage modal.
 */
export function UsageSidebarItem() {
  const { t } = useTranslation();
  const label = t(builtinSidebarNavLabelKey("usage"));
  const openUsage = useOpenSidebarUsage();
  const sources = useUsageSummary();
  if (sources.length === 0) return null;
  return <PinnedUsageTrigger label={label} sources={sources} onPress={openUsage} />;
}

const OpenSidebarUsageContext = createContext<(() => void) | null>(null);

/**
 * One owner for the footer icon and summary: both open the Usage modal over the current screen.
 * The modal mounts on first open and unmounts once it has finished closing, so its host's reports
 * load only while it is shown.
 */
export function UsageSidebarRoot({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const openUsage = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);
  const closeUsage = useCallback(() => setOpen(false), []);
  const unmountUsage = useCallback(() => setMounted(false), []);

  return (
    <OpenSidebarUsageContext.Provider value={openUsage}>
      {children}
      {mounted ? <UsageModal visible={open} onClose={closeUsage} onDismiss={unmountUsage} /> : null}
    </OpenSidebarUsageContext.Provider>
  );
}

/** Both sidebar entry points send the same open command. */
export function useOpenSidebarUsage(): () => void {
  const openUsage = useContext(OpenSidebarUsageContext);
  if (!openUsage) throw new Error("Sidebar Usage must be inside UsageSidebarRoot.");
  return openUsage;
}

function pinnedUsageLabel(label: string, sources: readonly PinnedUsageSource[]): string {
  const windows = sources.flatMap((source) => source.windows);
  return `${label}: ${windows.map((window) => window.label).join(", ")}`;
}

function triggerStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return hovered ? [styles.trigger, styles.triggerHovered] : styles.trigger;
}

/** Provider icons and separate account meters only; details live in the hover card. */
function PinnedUsageTrigger({
  label,
  sources,
  onPress,
}: {
  label: string;
  sources: readonly PinnedUsageSource[];
  onPress: () => void;
}) {
  const { preferences } = useUsagePreferences();
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={pinnedUsageLabel(label, sources)}
          style={triggerStyle}
          testID="sidebar-usage"
        >
          <View style={styles.line}>
            {sources.map((source) => (
              <View key={source.key} style={styles.source}>
                <View testID="sidebar-usage-source" accessibilityLabel={source.key}>
                  <UsageSourceIcon svg={source.icon} size={14} />
                </View>
                {source.windows.map((window) => (
                  <View
                    key={window.key}
                    style={styles.meterSlot}
                    testID="sidebar-usage-meter"
                    accessibilityLabel={window.label}
                  >
                    <UsageMeter
                      percent={window.percent}
                      tone={window.tone}
                      displayAs={preferences.displayAs}
                      style={styles.meter}
                    />
                  </View>
                ))}
              </View>
            ))}
          </View>
        </Pressable>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="end"
        offset={8}
        maxWidth={PINNED_USAGE_DETAILS_MAX_WIDTH}
        style={styles.detailsCard}
        testID="sidebar-usage-details"
      >
        <PinnedUsageHoverCard displayAs={preferences.displayAs} />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The hover card, mounted each time it opens, so the time left to each reset counts from then.
 */
function PinnedUsageHoverCard({ displayAs }: { displayAs: UsageDisplayAs }) {
  const [openedAt] = useState(Date.now);
  const providers = useUsageSummary(openedAt);
  return <PinnedUsageDetails providers={providers} displayAs={displayAs} />;
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
    // Same row geometry and leading rail as Add project and the footer icons.
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  line: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
    gap: theme.spacing[3],
  },
  source: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  meterSlot: {
    flex: 1,
    minWidth: 4,
  },
  meter: {
    height: 6,
    borderRadius: 3,
  },
  detailsCard: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
}));
