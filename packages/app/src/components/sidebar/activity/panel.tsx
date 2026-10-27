import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { create } from "zustand";
import { RetainedPanel, useRetainedPanelActive } from "@/components/retained-panel";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useHosts } from "@/runtime/host-runtime";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { density } from "@/styles/density";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { subscribeToRelativeTimeTick } from "@/utils/relative-time-ticker";
import type { RelativeTimeResolution } from "@/utils/time";
import { useHistoryConversations } from "@/screens/session-history/use-history-conversations";
import {
  activitySessionTiming,
  buildSidebarActivitySessions,
  describeActivityAge,
  type SidebarActivityView,
} from "./model";

type ActivityRow = ReturnType<typeof useHistoryConversations>["rows"][number];
const EMPTY_AGENTS: AggregatedAgent[] = [];

interface SidebarActivityState {
  view: SidebarActivityView;
  setView: (view: SidebarActivityView) => void;
}

const useSidebarActivityStore = create<SidebarActivityState>((set) => ({
  view: "all",
  setView: (view) => set({ view }),
}));
const activityViews = ["all", "running", "unreviewed"] as const;

function sessionKey(row: ActivityRow) {
  return `${row.agent.serverId}:${row.agent.id}`;
}

export function SidebarActivityPanel({
  active,
  onSessionPress,
  children,
}: {
  active: boolean;
  onSessionPress?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const view = useSidebarActivityStore((state) => state.view);
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const { agents, isInitialLoad } = useAggregatedAgents({ demand: active });
  const groups = useMemo(
    () => buildSidebarActivitySessions({ agents, serverIds, hostFilters }),
    [agents, serverIds, hostFilters],
  );
  const showingAll = view === "all";
  const sessions = showingAll ? [] : groups[view];
  let emptyLabel = t("sidebar.activity.emptyUnreviewed");
  if (view === "running") emptyLabel = t("sidebar.activity.emptyRunning");
  if (isInitialLoad) emptyLabel = t("sidebar.activity.loading");
  const emptyState = useMemo(() => <Text style={styles.empty}>{emptyLabel}</Text>, [emptyLabel]);

  return (
    <View style={styles.container}>
      <View style={styles.tabs} accessibilityRole="tablist" testID="sidebar-activity-tabs">
        {activityViews.map((tab) => {
          const selected = view === tab;
          let label = t(`sidebar.activity.${tab}`);
          if (tab !== "all") label = `${label} ${groups[tab].length}`;
          return <ActivityTab key={tab} tab={tab} selected={selected} label={label} />;
        })}
      </View>
      <RetainedPanel active={showingAll}>{children}</RetainedPanel>
      <RetainedPanel active={!showingAll}>
        {showingAll ? null : (
          <ActivitySessionList
            active={active}
            agents={sessions}
            emptyState={emptyState}
            onSessionPress={onSessionPress}
          />
        )}
      </RetainedPanel>
    </View>
  );
}

function ActivitySessionList({
  active,
  agents,
  emptyState,
  onSessionPress,
}: {
  active: boolean;
  agents: AggregatedAgent[];
  emptyState: ReactElement;
  onSessionPress?: () => void;
}) {
  const { rows } = useHistoryConversations(active ? agents : EMPTY_AGENTS);
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    if (nextWidth > 0) setWidth(nextWidth);
  }, []);
  const compact = width < 280;
  const renderSession = useCallback(
    ({ item }: { item: ActivityRow }) => (
      <ActivitySessionRow row={item} compact={compact} onSessionPress={onSessionPress} />
    ),
    [compact, onSessionPress],
  );
  return (
    <FlatList
      testID="sidebar-activity-sessions"
      onLayout={onLayout}
      extraData={compact}
      data={rows}
      keyExtractor={sessionKey}
      renderItem={renderSession}
      contentContainerStyle={styles.listContent}
      ListEmptyComponent={emptyState}
    />
  );
}

const ActivityTab = memo(function ActivityTab({
  tab,
  selected,
  label,
}: {
  tab: SidebarActivityView;
  selected: boolean;
  label: string;
}) {
  const setView = useSidebarActivityStore((state) => state.setView);
  const select = useCallback(() => setView(tab), [setView, tab]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <PressHighlight
      testID={`sidebar-activity-${tab}`}
      accessibilityRole="tab"
      accessibilityState={accessibilityState}
      aria-selected={selected}
      accessibilityLabel={label}
      onPress={select}
      style={[styles.tab, selected && styles.selectedTab]}
      highlightStyle={styles.pressed}
    >
      <Text numberOfLines={1} style={[styles.tabLabel, selected && styles.selectedLabel]}>
        {label}
      </Text>
    </PressHighlight>
  );
});

const ActivitySessionRow = memo(function ActivitySessionRow({
  row,
  compact,
  onSessionPress,
}: {
  row: ActivityRow;
  compact: boolean;
  onSessionPress?: () => void;
}) {
  const { t } = useTranslation();
  const { agent } = row;
  const [hovered, setHovered] = useState(false);
  const hoverIn = useCallback(() => setHovered(true), []);
  const hoverOut = useCallback(() => setHovered(false), []);
  const open = useCallback(() => {
    navigateToAgent({
      serverId: agent.serverId,
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      pin: true,
    });
    onSessionPress?.();
  }, [agent.serverId, agent.id, agent.workspaceId, onSessionPress]);
  const title = agent.title || t("sidebar.activity.untitled");
  const isRunning = agent.turn.phase === "open";
  const timing = activitySessionTiming({ isRunning, summary: row.summary });
  let unknownTime = "-";
  if (row.isLoading) unknownTime = t("sidebar.activity.loadingDetails");
  if (row.isError) unknownTime = t("sidebar.activity.detailsFailed");
  return (
    <View onPointerEnter={hoverIn} onPointerLeave={hoverOut}>
      <PressHighlight
        testID={`sidebar-activity-session-${agent.serverId}-${agent.id}`}
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={open}
        style={[styles.row, hovered && styles.pressed]}
        highlightStyle={styles.pressed}
      >
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <ActivityAges
          requestedAt={timing.requestedAt}
          completedAt={timing.completedAt}
          isRunning={isRunning}
          compact={compact}
          empty={unknownTime}
        />
        {!compact && row.summary.preview ? (
          <Text numberOfLines={1} style={styles.preview} testID="sidebar-activity-preview">
            {row.summary.preview}
          </Text>
        ) : null}
      </PressHighlight>
    </View>
  );
});

function ActivityAges({
  requestedAt,
  completedAt,
  isRunning,
  compact,
  empty,
}: {
  requestedAt: number | null;
  completedAt: number | null;
  isRunning: boolean;
  compact: boolean;
  empty: string;
}) {
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  const [now, setNow] = useState(Date.now);
  const requested = requestedAt === null ? null : describeActivityAge(requestedAt, now, t, compact);
  const completed = completedAt === null ? null : describeActivityAge(completedAt, now, t, compact);
  const resolutions = new Set([requested?.resolution, completed?.resolution]);
  let resolution: RelativeTimeResolution = "day";
  if (resolutions.has("second")) resolution = "second";
  else if (resolutions.has("minute")) resolution = "minute";
  else if (resolutions.has("hour")) resolution = "hour";
  useEffect(() => {
    if (!active || (requestedAt === null && completedAt === null)) return;
    const tick = () => setNow(Date.now());
    tick();
    return subscribeToRelativeTimeTick(resolution, tick);
  }, [active, requestedAt, completedAt, resolution]);
  const requestedData = useMemo(
    () => (requestedAt === null ? undefined : { timestamp: new Date(requestedAt).toISOString() }),
    [requestedAt],
  );
  const completedData = useMemo(
    () => (completedAt === null ? undefined : { timestamp: new Date(completedAt).toISOString() }),
    [completedAt],
  );
  const completedText = isRunning
    ? t(compact ? "sidebar.activity.inProgressShort" : "sidebar.activity.inProgress")
    : t("sidebar.activity.completedAt") + " " + (completed?.label ?? empty);
  return (
    <Text numberOfLines={1} style={styles.time} testID="sidebar-activity-ages">
      <Text testID="sidebar-activity-requested-at" dataSet={requestedData}>
        {t("sidebar.activity.requestedAt")} {requested?.label ?? empty}
      </Text>
      {" · "}
      <Text testID="sidebar-activity-completed-at" dataSet={completedData}>
        {completedText}
      </Text>
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  tabs: {
    flexDirection: "row",
    gap: theme.spacing[1],
    padding: theme.spacing[2],
  },
  tab: {
    flex: 1,
    minWidth: 0,
    minHeight: density.rowHeight,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[1],
  },
  selectedTab: { backgroundColor: theme.colors.surfaceSidebarSelected },
  tabLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  selectedLabel: { color: theme.colors.foreground },
  listContent: { paddingHorizontal: theme.spacing[2], paddingBottom: theme.spacing[4] },
  row: {
    padding: theme.spacing[2],
    marginBottom: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    gap: theme.spacing[1],
  },
  pressed: { backgroundColor: theme.colors.surfaceSidebarHover },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  preview: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  time: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  empty: {
    padding: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
