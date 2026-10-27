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
import { FlatList, Text, View } from "react-native";
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
import { useHistoryConversations } from "@/screens/session-history/use-history-conversations";
import {
  activitySessionTiming,
  buildSidebarActivitySessions,
  formatActivityDuration,
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
  const renderSession = useCallback(
    ({ item }: { item: ActivityRow }) => (
      <ActivitySessionRow row={item} onSessionPress={onSessionPress} />
    ),
    [onSessionPress],
  );
  return (
    <FlatList
      testID="sidebar-activity-sessions"
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
  onSessionPress,
}: {
  row: ActivityRow;
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
  const completedText = isRunning ? t("sidebar.activity.inProgress") : unknownTime;
  return (
    <View onPointerEnter={hoverIn} onPointerLeave={hoverOut}>
      <PressHighlight
        testID={`sidebar-activity-session-${agent.serverId}-${agent.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${agent.serverLabel}, ${agent.cwd}`}
        onPress={open}
        style={[styles.row, hovered && styles.pressed]}
        highlightStyle={styles.pressed}
      >
        <Text numberOfLines={2} style={styles.title}>
          {title}
        </Text>
        <Text numberOfLines={1} style={styles.metadata}>
          {agent.provider} · {row.workspaceName}
        </Text>
        <Text numberOfLines={1} style={styles.metadata}>
          {agent.serverLabel} · {row.pathLabel}
        </Text>
        {row.summary.preview ? (
          <Text numberOfLines={2} style={styles.preview} testID="sidebar-activity-preview">
            {row.summary.preview}
          </Text>
        ) : null}
        <View style={styles.timing}>
          <ActivityTimestamp
            label={t("sidebar.activity.requestedAt")}
            at={timing.requestedAt}
            empty={unknownTime}
            testID="sidebar-activity-requested-at"
          />
          <ActivityTimestamp
            label={t("sidebar.activity.completedAt")}
            at={timing.completedAt}
            empty={completedText}
            testID="sidebar-activity-completed-at"
          />
          <ActivityDuration
            requestedAt={timing.requestedAt}
            completedAt={timing.completedAt}
            isRunning={isRunning}
          />
        </View>
      </PressHighlight>
    </View>
  );
});

function ActivityTimestamp({
  label,
  at,
  empty,
  testID,
}: {
  label: string;
  at: number | null;
  empty: string;
  testID: string;
}) {
  const { i18n } = useTranslation();
  const dataSet = useMemo(
    () => (at === null ? undefined : { timestamp: new Date(at).toISOString() }),
    [at],
  );
  let value = empty;
  let description = label;
  if (at !== null) {
    const date = new Date(at);
    value = date.toLocaleString(i18n.language, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    description = `${label} ${date.toLocaleString(i18n.language)}`;
  }
  return (
    <View style={styles.timeRow} testID={testID} dataSet={dataSet} accessibilityLabel={description}>
      <Text style={styles.timeLabel}>{label}</Text>
      <Text style={styles.timeValue}>{value}</Text>
    </View>
  );
}

function ActivityDuration({
  requestedAt,
  completedAt,
  isRunning,
}: {
  requestedAt: number | null;
  completedAt: number | null;
  isRunning: boolean;
}) {
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !isRunning || requestedAt === null) return;
    const tick = () => setNow(Date.now());
    tick();
    return subscribeToRelativeTimeTick("second", tick);
  }, [active, isRunning, requestedAt]);
  const end = isRunning ? now : completedAt;
  let value = "-";
  if (requestedAt !== null && end !== null) value = formatActivityDuration(end - requestedAt, t);
  const label = isRunning ? t("sidebar.activity.elapsed") : t("sidebar.activity.duration");
  return (
    <View style={styles.timeRow} testID="sidebar-activity-duration">
      <Text style={styles.timeLabel}>{label}</Text>
      <Text style={styles.timeValue}>{value}</Text>
    </View>
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
  metadata: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  preview: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  timing: { gap: theme.spacing[1], marginTop: theme.spacing[1] },
  timeRow: { flexDirection: "row", alignItems: "baseline", gap: theme.spacing[2] },
  timeLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, minWidth: 32 },
  timeValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    fontVariant: ["tabular-nums"],
  },
  empty: {
    padding: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
