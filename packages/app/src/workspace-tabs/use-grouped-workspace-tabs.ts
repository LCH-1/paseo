import { useStableEvent } from "@/hooks/use-stable-event";
import { getTabGroupWindow, prepareTabGroupWindow } from "./tab-groups-window";
import { getDesktopHost } from "@/desktop/host";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type {
  WorkspaceDesktopTabRowItem,
  WorkspaceDesktopTabsRowProps,
} from "@/screens/workspace/workspace-desktop-tabs-row";
import type { WorkspaceTabPresentation } from "@/screens/workspace/workspace-tab-presentation";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { agentTabPresenceBridge } from "./agent-tab-presence";
import { useTabGroups } from "./tab-groups-store";
import {
  assignToTabGroup,
  groupForTab,
  projectTabGroups,
  removeFromTabGroups,
  reorderTabGroups,
  GROUP_HEADER_PREFIX,
  TAB_GROUP_COLORS,
  type TabGroup,
} from "./tab-groups";
import { confirmDialog } from "@/utils/confirm-dialog";
import { isWeb } from "@/constants/platform";

export interface GroupedTabRow extends WorkspaceDesktopTabRowItem {
  presentation: WorkspaceTabPresentation;
  groupHeader?: TabGroup;
}
function NoIcon() {
  return null;
}
function groupRow(group: TabGroup): GroupedTabRow {
  const key = GROUP_HEADER_PREFIX + group.id;
  return {
    tab: { key, tabId: key, kind: "new_tab", target: { kind: "new_tab" } },
    isActive: false,
    isCloseHovered: false,
    isClosingTab: false,
    groupHeader: group,
    presentation: {
      key,
      kind: "new_tab",
      label: group.name || "●",
      subtitle: "",
      tooltip: group.name || "이름 없는 그룹",
      modified: false,
      showCloseButton: false,
      titleState: "ready",
      icon: NoIcon,
      statusBucket: null,
    },
  };
}
export function useGroupedWorkspaceTabs(
  props: WorkspaceDesktopTabsRowProps,
  resolved: GroupedTabRow[],
) {
  const groupWindow = useMemo(() => getTabGroupWindow(), []);
  const state = useTabGroups((store) => store.state),
    update = useTabGroups((store) => store.update);
  const [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const pending = useRef<{ groupId: string; before: Set<string> } | null>(null);
  const capture = (tab: WorkspaceTabDescriptor): WorkspaceTabDescriptor => ({
    ...tab,
    groupSource: tab.groupSource ?? {
      serverId: props.normalizedServerId,
      workspaceId: props.normalizedWorkspaceId,
      tabId: tab.tabId,
    },
  });
  const pin = (tab: WorkspaceTabDescriptor) => {
    props.onKeepTab?.(tab);
    const source = capture(tab).groupSource!;
    if (tab.target.kind === "agent")
      agentTabPresenceBridge.retain({ ...source, agentId: tab.target.agentId });
  };
  const assign = useStableEvent((id: string, keys: string[]) => {
    const tabs = props.tabs
      .filter((row) => keys.includes(row.tab.key))
      .map((row) => capture(row.tab));
    tabs.forEach(pin);
    update((current) => assignToTabGroup(current, id, tabs));
  });
  const targets = (key: string) => (selected.includes(key) ? selected : [key]);
  const create = (key: string) => {
    const keys = targets(key),
      tabs = props.tabs.filter((row) => keys.includes(row.tab.key)).map((row) => capture(row.tab));
    tabs.forEach(pin);
    const id = globalThis.crypto.randomUUID();
    update((current) =>
      assignToTabGroup(
        {
          ...current,
          groups: [
            ...current.groups,
            {
              id,
              name: "",
              windowKey: groupWindow.key,
              color: Object.keys(TAB_GROUP_COLORS)[current.groups.length % 9] as TabGroup["color"],
              collapsed: false,
              closed: false,
              tabs: [],
            },
          ],
        },
        id,
        tabs,
      ),
    );
    setEditingGroupId(id);
  };
  const patch = useStableEvent((id: string, change: Partial<TabGroup>) =>
    update((current) => ({
      ...current,
      groups: current.groups.map((group) => (group.id === id ? { ...group, ...change } : group)),
    })),
  );
  const ungroup = (id: string) =>
    update((current) => ({
      ...current,
      groups: current.groups.filter((group) => group.id !== id),
    }));
  const close = async (id: string, remove = false) => {
    const group = state.groups.find((candidate) => candidate.id === id);
    if (!group) return;
    if (
      remove &&
      !(await confirmDialog({
        title: "그룹 삭제",
        message: "그룹과 그룹의 탭을 닫고 저장된 그룹을 삭제합니다. 대화 내용은 기록에 남습니다.",
        confirmLabel: "삭제",
        cancelLabel: "취소",
        destructive: true,
      }))
    )
      return;
    const members = props.tabs
      .filter((row) => group.tabs.some((tab) => tab.key === row.tab.key))
      .sort((a, b) => Number(a.isActive) - Number(b.isActive));
    try {
      for (const row of members) await props.onCloseTab(row.tab.tabId);
      if (remove) ungroup(id);
      else patch(id, { closed: true });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const open = (id: string) => {
    const group = state.groups.find((candidate) => candidate.id === id);
    if (!group) return;
    for (const tab of group.tabs) {
      const source = tab.groupSource;
      if (!source) continue;
      const tabId = useWorkspaceLayoutStore.getState().openTab({
        workspaceKey: `${source.serverId}:${source.workspaceId}`,
        target: tab.target,
        intent: "background",
        pin: true,
      });
      if (tabId && tab.target.kind === "agent")
        agentTabPresenceBridge.retain({ ...source, tabId, agentId: tab.target.agentId });
    }
    patch(id, { closed: false, collapsed: false, windowKey: groupWindow.key });
    const first = group.tabs[0];
    if (first?.groupSource)
      navigateToWorkspace({ ...first.groupSource, target: first.target, pin: true });
  };
  const newTab = (id: string) => {
    pending.current = { groupId: id, before: new Set(props.tabs.map((row) => row.tab.key)) };
    patch(id, { collapsed: false });
    props.onCreateNewTab({ paneId: props.paneId });
  };
  useEffect(() => {
    const waiting = pending.current;
    if (!waiting) return;
    const added = props.tabs.find((row) => !waiting.before.has(row.tab.key));
    if (!added) return;
    pending.current = null;
    assign(waiting.groupId, [added.tab.key]);
  }, [props.tabs, assign]);
  useEffect(() => {
    if (!isWeb) return;
    const listener = (event: StorageEvent) => {
      if (event.key === "workspace-tab-groups") void useTabGroups.persist.rehydrate();
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, []);
  const activeKey = props.tabs.find((row) => row.isActive)?.tab.key;
  useEffect(() => {
    const group = groupForTab(useTabGroups.getState().state, activeKey ?? "");
    if (group?.collapsed) patch(group.id, { collapsed: false });
  }, [activeKey, patch]);
  const rows = useMemo(
    () =>
      projectTabGroups(state, resolved, groupWindow.key).map((item) =>
        "group" in item ? groupRow(item.group) : item.row,
      ),
    [resolved, state, groupWindow.key],
  );
  const movedWindow = useRef(false);
  useEffect(() => {
    if (movedWindow.current || !groupWindow.groupId) return;
    const group = state.groups.find((candidate) => candidate.id === groupWindow.groupId);
    const first = group?.tabs[0];
    if (!first?.groupSource) return;
    movedWindow.current = true;
    navigateToWorkspace({ ...first.groupSource, target: first.target, pin: true });
  }, [state, groupWindow]);
  const moveToWindow = async (id: string) => {
    const api = getDesktopHost()?.window?.openNew;
    if (!api) return;
    const group = state.groups.find((candidate) => candidate.id === id);
    if (!group) return;
    const key = prepareTabGroupWindow(
      id,
      props.tabs
        .filter((row) => !group.tabs.some((tab) => tab.key === row.tab.key))
        .map((row) => row.tab.key),
    );
    patch(id, { windowKey: key });
    try {
      await api();
    } catch (cause) {
      patch(id, { windowKey: group.windowKey });
      setError(String(cause));
    }
  };
  return {
    rows,
    context: {
      state,
      selected,
      error,
      editingGroupId,
      endEditing: () => setEditingGroupId(null),
      groupFor: (key: string) => groupForTab(state, key),
      moveToWindow,
      patch,
      ungroup,
      close,
      open,
      newTab,
      create,
      assign: (id: string, key: string) => assign(id, targets(key)),
      remove: (key: string) => update((current) => removeFromTabGroups(current, targets(key))),
      select(key: string, event: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) {
        if (event.shiftKey && anchor.current) {
          const keys = rows.filter((row) => !row.groupHeader).map((row) => row.tab.key),
            a = keys.indexOf(anchor.current),
            b = keys.indexOf(key);
          setSelected(keys.slice(Math.min(a, b), Math.max(a, b) + 1));
          return true;
        }
        if (event.ctrlKey || event.metaKey) {
          setSelected((current) =>
            current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
          );
          anchor.current = key;
          return true;
        }
        setSelected([]);
        anchor.current = key;
        return false;
      },
      reorder(next: WorkspaceTabDescriptor[], movedKey?: string) {
        const all = new Map(props.tabs.map((row) => [row.tab.key, row.tab]));
        const dragging = next.find((tab) => tab.key === movedKey);
        let current = state;
        if (
          dragging &&
          !movedKey?.startsWith(GROUP_HEADER_PREFIX) &&
          !groupForTab(current, dragging.key)
        ) {
          const index = next.findIndex((tab) => tab.key === movedKey),
            prev = next[index - 1];
          const destination = prev?.key.startsWith(GROUP_HEADER_PREFIX)
            ? current.groups.find((group) => GROUP_HEADER_PREFIX + group.id === prev.key)
            : groupForTab(current, prev?.key ?? "");
          if (destination) {
            pin(dragging);
            current = assignToTabGroup(current, destination.id, [capture(dragging)]);
          }
        }
        const reordered = reorderTabGroups(
          current,
          next.map((tab) => tab.key),
          movedKey,
        );
        update(() => reordered);
        props.onReorderTabs([
          ...reordered.order.filter((key) => all.has(key)).map((key) => all.get(key)!),
          ...props.tabs.map((row) => row.tab).filter((tab) => !reordered.order.includes(tab.key)),
        ]);
      },
      closeTab(id: string) {
        const key = props.tabs.find((row) => row.tab.tabId === id)?.tab.key;
        if (key) update((current) => removeFromTabGroups(current, [key]));
        return props.onCloseTab(id);
      },
    },
  };
}
export type TabGroupRowContextValue = ReturnType<typeof useGroupedWorkspaceTabs>["context"];
export const TabGroupRowContext = createContext<TabGroupRowContextValue | null>(null);
export const useTabGroupRow = () => useContext(TabGroupRowContext);
