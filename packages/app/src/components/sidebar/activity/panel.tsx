import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { create } from "zustand";
import { RetainedPanel } from "@/components/retained-panel";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useHosts } from "@/runtime/host-runtime";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { density } from "@/styles/density";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { shortenPath } from "@/utils/shorten-path";
import { buildSidebarActivitySessions, type SidebarActivityView } from "./model";

interface SidebarActivityState {
  view: SidebarActivityView;
  setView: (view: SidebarActivityView) => void;
}

const useSidebarActivityStore = create<SidebarActivityState>((set) => ({
  view: "all",
  setView: (view) => set({ view }),
}));
const activityViews = ["all", "running", "unreviewed"] as const;

function sessionKey(agent: AggregatedAgent) {
  return `${agent.serverId}:${agent.id}`;
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
  const renderSession = useCallback(
    ({ item }: { item: AggregatedAgent }) => (
      <ActivitySessionRow agent={item} onSessionPress={onSessionPress} />
    ),
    [onSessionPress],
  );
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
        <FlatList
          testID="sidebar-activity-sessions"
          data={sessions}
          keyExtractor={sessionKey}
          renderItem={renderSession}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={emptyState}
        />
      </RetainedPanel>
    </View>
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
  agent,
  onSessionPress,
}: {
  agent: AggregatedAgent;
  onSessionPress?: () => void;
}) {
  const { t } = useTranslation();
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
          {agent.serverLabel} · {shortenPath(agent.cwd)}
        </Text>
      </PressHighlight>
    </View>
  );
});

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
  empty: {
    padding: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
