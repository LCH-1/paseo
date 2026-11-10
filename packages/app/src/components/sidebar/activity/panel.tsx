import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { create } from "zustand";
import { FolderOpen } from "lucide-react-native";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { RetainedPanel, useRetainedPanelActive } from "@/components/retained-panel";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { getDesktopHost } from "@/desktop/host";
import { useProjects } from "@/hooks/use-projects";
import type { ProjectHostEntry } from "@/utils/projects";
import { SidebarProviderIcon } from "../sidebar-provider-icon";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { markActivitySessionsRead } from "./mark-all-read";
import { useAgentTabTitle } from "@/plugins/agent-tab-titles/use-title";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { density } from "@/styles/density";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { subscribeToRelativeTimeTick } from "@/utils/relative-time-ticker";
import { shortenPath } from "@/utils/shorten-path";
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
  const setView = useSidebarActivityStore((state) => state.setView);
  const showProjects = useCallback(() => setView("projects"), [setView]);
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const { agents, isInitialLoad } = useAggregatedAgents({ demand: active });
  const groups = useMemo(
    () => buildSidebarActivitySessions({ agents, serverIds, hostFilters }),
    [agents, serverIds, hostFilters],
  );
  const showingAll = view === "all";
  const showingSessions = view === "running" || view === "unreviewed";
  const sessions = showingSessions ? groups[view] : [];
  const canOpenProjects = Boolean(getDesktopHost()?.window?.openProject);
  let emptyLabel = t("sidebar.activity.emptyUnreviewed");
  if (view === "running") emptyLabel = t("sidebar.activity.emptyRunning");
  if (isInitialLoad) emptyLabel = t("sidebar.activity.loading");
  const emptyState = useMemo(() => <Text style={styles.empty}>{emptyLabel}</Text>, [emptyLabel]);

  return (
    <View style={styles.container}>
      {canOpenProjects ? (
        <SidebarHeaderRow
          icon={FolderOpen}
          label={t("settings.projects")}
          onPress={showProjects}
          isActive={view === "projects"}
          testID="sidebar-activity-projects"
          variant="compact"
        />
      ) : null}
      <View style={styles.tabsSection} testID="sidebar-activity-filter-section">
        <View style={styles.tabs} accessibilityRole="tablist" testID="sidebar-activity-tabs">
          {activityViews.map((tab) => {
            const selected = view === tab;
            const label = t(`sidebar.activity.${tab}`);
            const count = tab === "running" || tab === "unreviewed" ? groups[tab].length : null;
            return (
              <ActivityTab key={tab} tab={tab} selected={selected} label={label} count={count} />
            );
          })}
        </View>
      </View>
      <RetainedPanel active={showingAll}>{children}</RetainedPanel>
      <RetainedPanel active={showingSessions}>
        {view === "unreviewed" ? <ActivityMarkAllRead agents={sessions} /> : null}
        {showingSessions ? (
          <ActivitySessionList
            key={view}
            active={active}
            agents={sessions}
            emptyState={emptyState}
            onSessionPress={onSessionPress}
          />
        ) : null}
      </RetainedPanel>
      {view === "projects" ? <ProjectWindowList active={active} /> : null}
    </View>
  );
}

type ProjectWindowListRow =
  | { kind: "host"; key: string; label: string }
  | { kind: "project"; key: string; host: ProjectHostEntry; name: string };

function projectWindowRowKey(row: ProjectWindowListRow) {
  return `${row.kind}:${row.key}`;
}

function ProjectWindowList({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const hosts = useHosts();
  const { projects, hostErrors, isLoading, refetch } = useProjects({ enabled: active });
  const opening = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const rows = useMemo(() => {
    const result: ProjectWindowListRow[] = [];
    for (const server of hosts) {
      const entries = projects.flatMap((project) =>
        project.hosts
          .filter((host) => host.serverId === server.serverId)
          .map((host) => ({
            kind: "project" as const,
            key: `${host.serverId}:${host.projectId}`,
            host,
            name: host.projectCustomName ?? project.projectCustomName ?? project.projectName,
          })),
      );
      if (entries.length === 0) continue;
      result.push({ kind: "host", key: server.serverId, label: server.label }, ...entries);
    }
    return result;
  }, [hosts, projects]);
  const open = useCallback(
    async (row: Extract<ProjectWindowListRow, { kind: "project" }>) => {
      const openProject = getDesktopHost()?.window?.openProject;
      if (!openProject || opening.current) return;
      opening.current = true;
      setPending(row.key);
      try {
        await openProject({
          serverId: row.host.serverId,
          projectId: row.host.projectId,
          projectName: row.name,
          directory: row.host.repoRoot,
        });
      } catch (error) {
        console.warn("Failed to open project window", error);
        toast.error(t("sidebar.project.actions.openNewWindowFailed"));
      } finally {
        opening.current = false;
        setPending(null);
      }
    },
    [t, toast],
  );
  const header = useMemo(
    () =>
      hostErrors.length > 0 ? (
        <View>
          {hostErrors.map((error) => (
            <Text key={error.serverId} accessibilityRole="alert" style={styles.readError}>
              {t("settings.projectList.hostLoadFailed", {
                hostName: error.serverName,
                message: error.message,
              })}
            </Text>
          ))}
          <Button variant="ghost" size="xs" onPress={refetch}>
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null,
    [hostErrors, refetch, t],
  );
  const empty = useMemo(
    () => (
      <Text style={styles.empty}>
        {t(isLoading ? "common.states.loading" : "sidebar.project.empty.title")}
      </Text>
    ),
    [isLoading, t],
  );
  const renderProject = useCallback(
    ({ item }: { item: ProjectWindowListRow }) => (
      <ProjectWindowRow item={item} pending={pending} onOpen={open} />
    ),
    [pending, open],
  );
  return (
    <FlatList
      testID="sidebar-project-list"
      data={rows}
      keyExtractor={projectWindowRowKey}
      contentContainerStyle={styles.listContent}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      renderItem={renderProject}
    />
  );
}

const ProjectWindowRow = memo(function ProjectWindowRow({
  item,
  pending,
  onOpen,
}: {
  item: ProjectWindowListRow;
  pending: string | null;
  onOpen: (row: Extract<ProjectWindowListRow, { kind: "project" }>) => Promise<void>;
}) {
  const open = useCallback(() => {
    if (item.kind === "project") void onOpen(item);
  }, [item, onOpen]);
  const label = useMemo(
    () =>
      item.kind === "project" ? (
        <View style={styles.projectLabel}>
          <Text numberOfLines={1} style={styles.title}>
            {item.name}
          </Text>
          <Text numberOfLines={1} style={styles.preview}>
            {shortenPath(item.host.repoRoot)}
          </Text>
        </View>
      ) : null,
    [item],
  );
  return item.kind === "host" ? (
    <Text accessibilityRole="header" style={styles.projectHost}>
      {item.label}
    </Text>
  ) : (
    <Button
      testID={`sidebar-project-${item.key}`}
      accessibilityLabel={item.name}
      variant="ghost"
      disabled={pending !== null}
      loading={pending === item.key}
      onPress={open}
      style={styles.projectButton}
      trailing={label}
    />
  );
});

function ActivityMarkAllRead({ agents }: { agents: AggregatedAgent[] }) {
  const { t } = useTranslation();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(0);
  const markAllRead = useCallback(async () => {
    if (busy.current || agents.length === 0) return;
    busy.current = true;
    setPending(true);
    setFailed(0);
    try {
      const runtime = getHostRuntimeStore();
      setFailed(await markActivitySessionsRead(agents, (serverId) => runtime.getClient(serverId)));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, [agents]);
  return (
    <View style={styles.readActions}>
      <Button
        testID="sidebar-activity-mark-all-read"
        variant="ghost"
        size="xs"
        loading={pending}
        disabled={pending || agents.length === 0}
        onPress={markAllRead}
      >
        {t(pending ? "sidebar.activity.markingAllRead" : "sidebar.activity.markAllRead")}
      </Button>
      {failed > 0 ? (
        <Text accessibilityRole="alert" style={styles.readError}>
          {t("sidebar.activity.markAllReadFailed", { count: failed })}
        </Text>
      ) : null}
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
  const [pressed, setPressed] = useState<{ row: ActivityRow; index: number } | null>(null);
  const releasePressed = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (releasePressed.current) clearTimeout(releasePressed.current);
    },
    [],
  );
  const retainPressed = useCallback(
    (row: ActivityRow) => {
      if (releasePressed.current) clearTimeout(releasePressed.current);
      setPressed({ row, index: rows.findIndex((item) => sessionKey(item) === sessionKey(row)) });
      // Reading a conversation removes it from Unreviewed. Keep the clicked DOM
      // row stable through the second click, even if its attention clears first.
      releasePressed.current = setTimeout(() => setPressed(null), 600);
    },
    [rows],
  );
  const displayedRows = useMemo(() => {
    if (!pressed || rows.some((row) => sessionKey(row) === sessionKey(pressed.row))) return rows;
    const next = [...rows];
    next.splice(Math.max(0, Math.min(pressed.index, next.length)), 0, pressed.row);
    return next;
  }, [rows, pressed]);
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    if (nextWidth > 0) setWidth(nextWidth);
  }, []);
  const compact = width < 280;
  const renderSession = useCallback(
    ({ item }: { item: ActivityRow }) => (
      <ActivitySessionRow
        row={item}
        compact={compact}
        onSessionPress={onSessionPress}
        onOpen={retainPressed}
      />
    ),
    [compact, onSessionPress, retainPressed],
  );
  return (
    <FlatList
      testID="sidebar-activity-sessions"
      onLayout={onLayout}
      extraData={compact}
      data={displayedRows}
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
  count,
}: {
  tab: SidebarActivityView;
  selected: boolean;
  label: string;
  count: number | null;
}) {
  const setView = useSidebarActivityStore((state) => state.setView);
  const select = useCallback(() => setView(tab), [setView, tab]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const accessibilityLabel = count === null ? label : `${label} ${count}`;
  return (
    <PressHighlight
      testID={`sidebar-activity-${tab}`}
      accessibilityRole="tab"
      accessibilityState={accessibilityState}
      aria-selected={selected}
      accessibilityLabel={accessibilityLabel}
      onPress={select}
      style={styles.tab}
      highlightStyle={styles.pressed}
    >
      <Text numberOfLines={1} style={[styles.tabLabel, selected && styles.selectedLabel]}>
        {label}
      </Text>
      {count !== null ? (
        <View style={[styles.countBadge, selected && styles.selectedCountBadge]}>
          <Text style={[styles.countLabel, selected && styles.selectedLabel]}>{count}</Text>
        </View>
      ) : null}
      {selected ? <View style={styles.activeIndicator} /> : null}
    </PressHighlight>
  );
});

const ActivitySessionRow = memo(function ActivitySessionRow({
  row,
  compact,
  onSessionPress,
  onOpen,
}: {
  row: ActivityRow;
  compact: boolean;
  onSessionPress?: () => void;
  onOpen: (row: ActivityRow) => void;
}) {
  const { t } = useTranslation();
  const { agent } = row;
  const [hovered, setHovered] = useState(false);
  const hoverIn = useCallback(() => setHovered(true), []);
  const hoverOut = useCallback(() => setHovered(false), []);
  const open = useCallback(() => {
    onOpen(row);
    navigateToAgent({
      serverId: agent.serverId,
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      pin: true,
    });
    onSessionPress?.();
  }, [agent.serverId, agent.id, agent.workspaceId, onSessionPress, onOpen, row]);
  const title = agent.title || t("sidebar.activity.untitled");
  const tabTitle = useAgentTabTitle({
    serverId: agent.serverId,
    workspaceId: agent.workspaceId ?? "",
    agentId: agent.id,
    defaultLabel: title,
  });
  let tabName = title;
  if (typeof tabTitle === "string") tabName = tabTitle;
  else if (tabTitle) tabName = `${tabTitle.primaryLabel}-${tabTitle.secondaryLabel}`;
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
        accessibilityLabel={`${tabName}, ${title}`}
        onPress={open}
        style={[styles.row, hovered && styles.pressed]}
        highlightStyle={styles.pressed}
      >
        <View style={styles.tabNameRow}>
          <SidebarProviderIcon provider={agent.provider} serverId={agent.serverId} />
          <Text numberOfLines={1} style={styles.tabName} testID="sidebar-activity-tab-name">
            {tabName}
          </Text>
        </View>
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
  projectHost: {
    padding: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  projectButton: {
    justifyContent: "flex-start",
    height: "auto",
    paddingVertical: theme.spacing[2],
  },
  projectLabel: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  readActions: { alignItems: "flex-end", paddingHorizontal: theme.spacing[2] },
  readError: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[2],
  },
  tabsSection: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[2],
    marginBottom: theme.spacing[1],
  },
  tabs: {
    flexDirection: "row",
    gap: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface3,
  },
  tab: {
    flex: 1,
    minWidth: 0,
    minHeight: density.rowHeight,
    flexDirection: "row",
    gap: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[1],
  },
  tabLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  selectedLabel: {
    color: theme.colors.sidebarFilterSelectedForeground,
    fontWeight: theme.fontWeight.medium,
  },
  activeIndicator: {
    position: "absolute",
    bottom: -1,
    left: theme.spacing[2],
    right: theme.spacing[2],
    height: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.sidebarFilterSelectedBorder,
  },
  countBadge: {
    minWidth: theme.spacing[4] + theme.spacing[1],
    height: theme.spacing[4] + theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  selectedCountBadge: { backgroundColor: theme.colors.sidebarFilterSelectedBackground },
  countLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  listContent: { paddingHorizontal: theme.spacing[2], paddingBottom: theme.spacing[4] },
  row: {
    padding: theme.spacing[2],
    marginBottom: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    gap: theme.spacing[1],
  },
  pressed: { backgroundColor: theme.colors.surfaceSidebarHover },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  tabNameRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  tabName: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
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
