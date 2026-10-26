import { useState, useSyncExternalStore, type ReactElement } from "react";
import { FlatList, Modal, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useCompletionTimeAgo } from "@/hooks/use-time-ago";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { agentTabPresenceBridge } from "@/workspace-tabs/agent-tab-presence";
import { useHistoryConversations } from "./use-history-conversations";

const columns = [
  "host",
  "path",
  "workspace name",
  "작업내용",
  "마지막 탭 닫힘",
  "마지막 요청",
  "마지막 응답 ↓",
];
const widths = [130, 220, 180, 380, 150, 130, 130];

function ElapsedTime({ at }: { at: number }) {
  const date = new Date(at);
  const label = useCompletionTimeAgo(date);
  return (
    <Text
      style={styles.time}
      accessibilityLabel={date.toLocaleString()}
      dataSet={{ timestamp: date.toISOString() }}
    >
      {label}
    </Text>
  );
}

function Cell({ text, index }: { text: string; index: number }) {
  return (
    <Text
      style={[styles.cell, { width: widths[index] }]}
      numberOfLines={1}
      selectable
      accessibilityLabel={text}
    >
      {text}
    </Text>
  );
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
  const [actionAgent, setActionAgent] = useState<AggregatedAgent | null>(null);
  const { archiveAgent } = useArchiveAgent();
  useSyncExternalStore(
    agentTabPresenceBridge.subscribe,
    agentTabPresenceBridge.getSnapshot,
    agentTabPresenceBridge.getSnapshot,
  );
  return (
    <View style={styles.container} testID="session-history-table">
      <View style={styles.toolbar}>
        <Text style={styles.hint}>
          {isLoading || isLoadingPages
            ? "대화 시간 확인 중… · 마지막 응답 최신순"
            : "마지막 응답 최신순 · 탭 닫힘은 이 PC 기준"}
        </Text>
        <Button variant="ghost" onPress={onRefresh} disabled={isRefreshing}>
          새로고침
        </Button>
      </View>
      <ScrollView
        horizontal
        style={styles.horizontal}
        contentContainerStyle={styles.horizontalContent}
      >
        <View style={styles.table}>
          <View style={styles.header}>
            {columns.map((name, index) => (
              <Cell key={name} text={name} index={index} />
            ))}
          </View>
          <FlatList
            data={rows}
            keyExtractor={({ agent }) => JSON.stringify([agent.serverId, agent.id])}
            refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />}
            ListFooterComponent={footer}
            renderItem={({
              item: {
                agent,
                workspaceName,
                pathLabel,
                isWorking,
                summary,
                isLoading: pending,
                isError,
              },
            }) => {
              const presence = agentTabPresenceBridge.read(agent.serverId, agent.id);
              return (
                <Pressable
                  testID={`history-row-${agent.serverId}-${agent.id}`}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={`${workspaceName}, ${agent.title ?? ""}`}
                  onPress={() =>
                    navigateToAgent({
                      serverId: agent.serverId,
                      agentId: agent.id,
                      workspaceId: agent.workspaceId,
                      pin: true,
                    })
                  }
                  onLongPress={() => setActionAgent(agent)}
                >
                  <Cell text={agent.serverLabel} index={0} />
                  <Cell text={pathLabel} index={1} />
                  <Cell text={workspaceName} index={2} />
                  <View style={[styles.work, { width: widths[3] }]}>
                    <Text style={styles.workTitle} numberOfLines={1} selectable>
                      {agent.title ?? workspaceName}
                    </Text>
                    <Text style={styles.preview} numberOfLines={1} selectable>
                      {summary.preview ||
                        (pending
                          ? "불러오는 중…"
                          : isError
                            ? "대화 내용을 불러오지 못했습니다"
                            : "대화 없음")}
                    </Text>
                  </View>
                  <View style={[styles.timeCell, { width: widths[4] }]}>
                    {presence?.isOpen ? (
                      <Text style={styles.open}>열림</Text>
                    ) : presence?.lastClosedAt != null ? (
                      <ElapsedTime at={presence.lastClosedAt} />
                    ) : (
                      <Text style={styles.time}>{presence ? "닫힘 · 기록 없음" : "확인 중"}</Text>
                    )}
                  </View>
                  <View style={[styles.timeCell, { width: widths[5] }]}>
                    {summary.lastRequestAt !== null ? (
                      <ElapsedTime at={summary.lastRequestAt} />
                    ) : (
                      <Text style={styles.time}>{pending ? "…" : "—"}</Text>
                    )}
                  </View>
                  <View style={[styles.timeCell, { width: widths[6] }]}>
                    {isWorking ? (
                      <Text style={styles.open}>작업중</Text>
                    ) : summary.lastResponseAt !== null ? (
                      <ElapsedTime at={summary.lastResponseAt} />
                    ) : (
                      <Text style={styles.time}>{pending ? "…" : isError ? "조회 실패" : "—"}</Text>
                    )}
                  </View>
                </Pressable>
              );
            }}
          />
        </View>
      </ScrollView>
      <Modal
        visible={actionAgent !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setActionAgent(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setActionAgent(null)}>
          <View style={styles.actions}>
            <Text style={styles.workTitle}>{actionAgent?.title}</Text>
            <Button
              variant="ghost"
              onPress={() => {
                if (actionAgent)
                  void archiveAgent({
                    serverId: actionAgent.serverId,
                    agentId: actionAgent.id,
                  }).catch(() => {});
                setActionAgent(null);
              }}
            >
              보관
            </Button>
            <Button variant="ghost" onPress={() => setActionAgent(null)}>
              닫기
            </Button>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, paddingHorizontal: theme.spacing[4] },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[2],
  },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  horizontal: { flex: 1 },
  horizontalContent: { flexGrow: 1 },
  table: { flex: 1, minWidth: widths.reduce((sum, width) => sum + width, 0) },
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
    paddingHorizontal: theme.spacing[2],
  },
  work: { paddingHorizontal: theme.spacing[2], gap: theme.spacing[1] },
  workTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  preview: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  timeCell: { paddingHorizontal: theme.spacing[2] },
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
