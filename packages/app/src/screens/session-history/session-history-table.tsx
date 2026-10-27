import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { FlatList, Modal, RefreshControl, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useCompletionTimeAgo } from "@/hooks/use-time-ago";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { agentTabPresenceBridge } from "@/workspace-tabs/agent-tab-presence";
import { useHistoryConversations } from "./use-history-conversations";
import { attachHistoryRowInteractions } from "./history-row-interactions";

const columns = [
  "host",
  "path",
  "workspace name",
  "작업내용",
  "마지막 탭 닫힘",
  "마지막 요청",
  "마지막 응답",
];
const widths = [130, 220, 180, 380, 150, 130, 130];

const columnStyles = widths.map((width) => ({ flexGrow: width, flexBasis: 0, minWidth: 0 }));
type HistoryRowData = ReturnType<typeof useHistoryConversations>["rows"][number];
function ElapsedTime({ at }: { at: number }) {
  const date = useMemo(() => new Date(at), [at]);
  const label = useCompletionTimeAgo(date);
  const dataSet = useMemo(() => ({ timestamp: date.toISOString() }), [date]);
  return (
    <Text style={styles.time} accessibilityLabel={date.toLocaleString()} dataSet={dataSet}>
      {label}
    </Text>
  );
}
function HistoryColumn({
  index,
  compact,
  children,
}: {
  index: number;
  compact: boolean;
  children: ReactNode;
}) {
  const metadata = compact && index < 3;
  const style = [
    styles.column,
    columnStyles[index],
    compact && styles.compactColumn,
    compact && index < 4 && styles.fullColumn,
    metadata && styles.metadata,
  ];
  return (
    <View style={style}>
      {compact ? (
        <Text style={[styles.fieldLabel, metadata && styles.metadataLabel]}>{columns[index]}</Text>
      ) : null}
      <View style={metadata ? styles.metadataValue : styles.value}>{children}</View>
    </View>
  );
}
function Cell({
  text,
  index,
  compact = false,
}: {
  text: string;
  index: number;
  compact?: boolean;
}) {
  return (
    <HistoryColumn index={index} compact={compact}>
      <Text style={styles.cell} numberOfLines={1} selectable accessibilityLabel={text}>
        {text}
      </Text>
    </HistoryColumn>
  );
}
function ClosedTime({ agent }: { agent: AggregatedAgent }) {
  const presence = agentTabPresenceBridge.read(agent.serverId, agent.id);
  if (presence?.isOpen) return <Text style={styles.open}>열림</Text>;
  if (presence?.lastClosedAt != null) return <ElapsedTime at={presence.lastClosedAt} />;
  return <Text style={styles.time}>{presence ? "닫힘 · 기록 없음" : "확인 중"}</Text>;
}
function ResponseTime({ row }: { row: HistoryRowData }) {
  if (row.isWorking) return <Text style={styles.open}>작업중</Text>;
  if (row.summary.lastResponseAt !== null) return <ElapsedTime at={row.summary.lastResponseAt} />;
  let label = "—";
  if (row.isLoading) label = "…";
  else if (row.isError) label = "조회 실패";
  return <Text style={styles.time}>{label}</Text>;
}
function HistoryRow({
  row,
  compact,
  onAction,
}: {
  row: HistoryRowData;
  compact: boolean;
  onAction: (agent: AggregatedAgent) => void;
}) {
  const { agent, workspaceName, pathLabel, summary } = row;
  const open = useCallback(
    () =>
      navigateToAgent({
        serverId: agent.serverId,
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        pin: true,
      }),
    [agent],
  );
  const actions = useCallback(() => onAction(agent), [agent, onAction]);
  const dataSet = useMemo(
    () => ({
      historyServerId: agent.serverId,
      historyWorkspaceId: agent.workspaceId,
      historyAgentId: agent.id,
    }),
    [agent],
  );
  const style = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.row,
      compact && styles.compactRow,
      pressed && styles.pressed,
    ],
    [compact],
  );
  let preview = summary.preview || "대화 없음";
  if (!summary.preview && row.isLoading) preview = "불러오는 중…";
  else if (!summary.preview && row.isError) preview = "대화 내용을 불러오지 못했습니다";
  return (
    <PressHighlight
      testID={`history-row-${agent.serverId}-${agent.id}`}
      dataSet={dataSet}
      style={style}
      accessibilityRole="button"
      accessibilityLabel={`${workspaceName}, ${agent.title ?? ""}`}
      onPress={open}
      onLongPress={actions}
    >
      <Cell text={agent.serverLabel} index={0} compact={compact} />
      <Cell text={pathLabel} index={1} compact={compact} />
      <Cell text={workspaceName} index={2} compact={compact} />
      <HistoryColumn index={3} compact={compact}>
        <Text style={styles.workTitle} numberOfLines={1} selectable>
          {agent.title ?? workspaceName}
        </Text>
        <Text style={styles.preview} numberOfLines={compact ? 2 : 1} selectable>
          {preview}
        </Text>
      </HistoryColumn>
      <HistoryColumn index={4} compact={compact}>
        <ClosedTime agent={agent} />
      </HistoryColumn>
      <HistoryColumn index={5} compact={compact}>
        {summary.lastRequestAt !== null ? (
          <ElapsedTime at={summary.lastRequestAt} />
        ) : (
          <Text style={styles.time}>{row.isLoading ? "…" : "—"}</Text>
        )}
      </HistoryColumn>
      <HistoryColumn index={6} compact={compact}>
        <ResponseTime row={row} />
      </HistoryColumn>
    </PressHighlight>
  );
}
function rowKey({ agent }: HistoryRowData) {
  return JSON.stringify([agent.serverId, agent.id]);
}

export function SessionHistoryTable({
  agents,
  isRefreshing,
  onRefresh,
  footer,
  isLoadingPages,
}: {
  agents: AggregatedAgent[];
  isRefreshing: boolean;
  onRefresh: () => void;
  footer: ReactElement | null;
  isLoadingPages: boolean;
}) {
  const { rows, isLoading } = useHistoryConversations(agents);
  const [compact, setCompact] = useState(true);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => setCompact(event.nativeEvent.layout.width < 1000),
    [],
  );
  const tableRef = useRef<View>(null);
  const [actionAgent, setActionAgent] = useState<AggregatedAgent | null>(null);
  const { archiveAgent } = useArchiveAgent();
  const renderRow = useCallback(
    ({ item }: { item: HistoryRowData }) => (
      <HistoryRow row={item} compact={compact} onAction={setActionAgent} />
    ),
    [compact],
  );
  const refreshControl = useMemo(
    () => <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />,
    [isRefreshing, onRefresh],
  );
  const closeActions = useCallback(() => setActionAgent(null), []);
  const archiveSelected = useCallback(() => {
    if (actionAgent)
      void archiveAgent({ serverId: actionAgent.serverId, agentId: actionAgent.id }).catch(
        () => {},
      );
    setActionAgent(null);
  }, [actionAgent, archiveAgent]);
  useSyncExternalStore(
    agentTabPresenceBridge.subscribe,
    agentTabPresenceBridge.getSnapshot,
    agentTabPresenceBridge.getSnapshot,
  );
  useEffect(() => {
    if (!isWeb) return;
    const node = tableRef.current as unknown as HTMLElement | null;
    if (!node) return;
    return attachHistoryRowInteractions(node, ({ serverId, workspaceId, agentId }) => {
      const tabId = useWorkspaceLayoutStore.getState().openTab({
        workspaceKey: `${serverId}:${workspaceId}`,
        target: { kind: "agent", agentId },
        intent: "background",
        pin: true,
      });
      if (tabId) agentTabPresenceBridge.retain({ serverId, workspaceId, agentId, tabId });
    });
  }, []);
  return (
    <View
      ref={tableRef}
      style={styles.container}
      onLayout={handleLayout}
      testID="session-history-table"
    >
      <View style={styles.toolbar}>
        <Text style={styles.hint}>
          {isLoading || isLoadingPages
            ? "대화 시간 확인 중… · 작업중 우선, 요청 최신순 → 완료 최신순"
            : "작업중 우선, 요청 최신순 → 완료 최신순 · 탭 닫힘은 이 PC 기준"}
        </Text>
        <Button variant="ghost" onPress={onRefresh} disabled={isRefreshing}>
          새로고침
        </Button>
      </View>
      <View style={styles.table}>
        {!compact ? (
          <View style={styles.header}>
            {columns.map((name, index) => (
              <Cell key={name} text={name} index={index} />
            ))}
          </View>
        ) : null}
        <FlatList
          style={styles.list}
          data={rows}
          keyExtractor={rowKey}
          refreshControl={refreshControl}
          ListFooterComponent={footer}
          renderItem={renderRow}
          extraData={compact}
        />
      </View>
      <Modal
        visible={actionAgent !== null}
        transparent
        animationType="fade"
        onRequestClose={closeActions}
      >
        <PressHighlight style={styles.backdrop} onPress={closeActions}>
          <View style={styles.actions}>
            <Text style={styles.workTitle}>{actionAgent?.title}</Text>
            <Button variant="ghost" onPress={archiveSelected}>
              보관
            </Button>
            <Button variant="ghost" onPress={closeActions}>
              닫기
            </Button>
          </View>
        </PressHighlight>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minWidth: 0, paddingHorizontal: theme.spacing[4] },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  hint: { flex: 1, minWidth: 0, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  table: { flex: 1, minWidth: 0 },
  list: { flex: 1, minWidth: 0, width: "100%" },
  column: { paddingHorizontal: theme.spacing[2], minWidth: 0 },
  compactColumn: { flexBasis: "33.333%", width: "33.333%", flexGrow: 0 },
  fullColumn: { flexBasis: "100%", width: "100%" },
  metadata: { flexDirection: "row", gap: theme.spacing[2] },
  metadataLabel: { width: 110, maxWidth: "45%", flexShrink: 1 },
  metadataValue: { flex: 1, minWidth: 0 },
  value: { minWidth: 0 },
  fieldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[1],
  },
  compactRow: { flexWrap: "wrap", alignItems: "flex-start", rowGap: theme.spacing[2] },
  header: {
    flexDirection: "row",
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  pressed: { backgroundColor: theme.colors.surface1 },
  cell: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  workTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  preview: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  time: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  open: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  backdrop: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0008" },
  actions: {
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    minWidth: 260,
  },
}));
