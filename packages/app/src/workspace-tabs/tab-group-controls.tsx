import { getIsElectron } from "@/constants/platform";
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text } from "react-native";
import { EditingTextInput } from "@/components/ui/text-input";
import { StyleSheet } from "react-native-unistyles";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { Folder } from "lucide-react-native";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { TAB_GROUP_COLORS, type TabGroup, type TabGroupColor } from "./tab-groups";
import { useTabGroupRow } from "./use-grouped-workspace-tabs";

function GroupColor({ color, group }: { color: TabGroupColor; group: TabGroup }) {
  const groups = useTabGroupRow()!;
  const selected = group.color === color;
  const state = useMemo(() => ({ selected }), [selected]);
  const style = useMemo(
    () => [
      styles.color,
      { backgroundColor: TAB_GROUP_COLORS[color], borderWidth: selected ? 3 : 0 },
    ],
    [color, selected],
  );
  const choose = useCallback(() => groups.patch(group.id, { color }), [groups, group.id, color]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={`그룹 색상 ${color}`}
      accessibilityState={state}
      onPress={choose}
      style={style}
    />
  );
}
export function TabGroupHeader({
  group,
  width,
  dragHandleProps,
}: {
  group: TabGroup;
  width: number;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  const groups = useTabGroupRow()!;
  const editing = groups.editingGroupId === group.id;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (editing) setOpen(true);
  }, [editing]);
  const actions = useMemo(
    () => ({
      toggle: () => groups.patch(group.id, { collapsed: !group.collapsed }),
      rename: (name: string) => groups.patch(group.id, { name }),
      ungroup: () => groups.ungroup(group.id),
      close: () => void groups.close(group.id),
      remove: () => void groups.close(group.id, true),
      newTab: () => groups.newTab(group.id),
      move: () => void groups.moveToWindow(group.id),
      openChange: (value: boolean) => {
        setOpen(value);
        if (!value) groups.endEditing();
      },
    }),
    [groups, group],
  );
  const color = TAB_GROUP_COLORS[group.color];
  const chip = useMemo(() => [styles.header, { width, borderBottomColor: color }], [width, color]);
  const label = useMemo(() => [styles.label, { backgroundColor: color }], [color]);
  const state = useMemo(() => ({ expanded: !group.collapsed }), [group.collapsed]);
  return (
    <ContextMenu
      compactMode={getIsElectron() ? "popover" : "sheet"}
      open={open}
      onOpenChange={actions.openChange}
    >
      <ContextMenuTrigger
        {...(dragHandleProps?.attributes as object)}
        {...(dragHandleProps?.listeners as object)}
        triggerRef={dragHandleProps?.setActivatorNodeRef as never}
        style={chip}
        onPress={actions.toggle}
        accessibilityLabel={group.name || "이름 없는 그룹"}
        accessibilityState={state}
        testID={`tab-group-${group.id}`}
      >
        <Text numberOfLines={1} style={label}>
          {group.name || "●"}
        </Text>
      </ContextMenuTrigger>
      <ContextMenuContent width={280} testID={`tab-group-menu-${group.id}`}>
        <EditingTextInput
          autoFocus={editing}
          selectTextOnFocus
          accessibilityLabel="그룹 이름"
          placeholder="그룹 이름"
          initialValue={group.name}
          onChangeText={actions.rename}
          style={styles.input}
        />
        <View style={styles.colors}>
          {(Object.keys(TAB_GROUP_COLORS) as TabGroupColor[]).map((choice) => (
            <GroupColor key={choice} color={choice} group={group} />
          ))}
        </View>
        {groups.error ? (
          <Text accessibilityRole="alert" style={styles.empty}>
            {groups.error}
          </Text>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={actions.newTab}>그룹에 새 탭 추가</ContextMenuItem>
        <ContextMenuItem onSelect={actions.toggle}>
          {group.collapsed ? "그룹 펼치기" : "그룹 접기"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={actions.move}>그룹을 새 창으로 이동</ContextMenuItem>
        <ContextMenuItem onSelect={actions.ungroup}>그룹 해제</ContextMenuItem>
        <ContextMenuItem onSelect={actions.close}>그룹 닫기</ContextMenuItem>
        <ContextMenuItem onSelect={actions.remove}>그룹 삭제</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
function GroupDestination({ group, tabKey }: { group: TabGroup; tabKey: string }) {
  const groups = useTabGroupRow()!;
  const assign = useCallback(() => groups.assign(group.id, tabKey), [groups, group.id, tabKey]);
  const style = useMemo(() => ({ color: TAB_GROUP_COLORS[group.color] }), [group.color]);
  return (
    <ContextMenuItem onSelect={assign}>
      <Text style={style}>● </Text>
      {group.name || "이름 없는 그룹"}에 탭 추가
    </ContextMenuItem>
  );
}
function TabGroupItemsInner({ tabKey }: { tabKey: string }) {
  const groups = useTabGroupRow()!;
  const current = groups.groupFor(tabKey);
  const create = useCallback(() => groups.create(tabKey), [groups, tabKey]);
  const remove = useCallback(() => groups.remove(tabKey), [groups, tabKey]);
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={create}>새 그룹에 탭 추가</ContextMenuItem>
      {groups.state.groups
        .filter((group) => !group.closed && group.id !== current?.id)
        .map((group) => (
          <GroupDestination key={group.id} group={group} tabKey={tabKey} />
        ))}
      {current ? <ContextMenuItem onSelect={remove}>그룹에서 삭제</ContextMenuItem> : null}
    </>
  );
}
function SavedGroup({ group }: { group: TabGroup }) {
  const groups = useTabGroupRow()!;
  const open = useCallback(() => groups.open(group.id), [groups, group.id]);
  const remove = useCallback(() => void groups.close(group.id, true), [groups, group.id]);
  const style = useMemo(() => ({ color: TAB_GROUP_COLORS[group.color] }), [group.color]);
  return (
    <View>
      <DropdownMenuItem onSelect={open}>
        <Text style={style}>● </Text>
        {group.name || "이름 없는 그룹"}
        {group.closed ? " · 닫힘" : ""}
      </DropdownMenuItem>
      {group.closed ? <DropdownMenuItem onSelect={remove}>그룹 삭제</DropdownMenuItem> : null}
    </View>
  );
}
export function SavedTabGroups() {
  const groups = useTabGroupRow()!;
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <ToolbarButton kind="menu" label="저장된 탭 그룹" testID="saved-tab-groups">
        <Folder size={14} color="#9aa0a6" />
      </ToolbarButton>
      <DropdownMenuContent width={280}>
        {groups.state.groups.length === 0 ? (
          <Text style={styles.empty}>저장된 탭 그룹 없음</Text>
        ) : null}
        {groups.state.groups.map((group) => (
          <SavedGroup key={group.id} group={group} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
const styles = StyleSheet.create((theme) => ({
  header: {
    height: 35,
    justifyContent: "center",
    paddingHorizontal: 4,
    borderBottomWidth: 3,
    flexShrink: 0,
  },
  label: {
    fontSize: 12,
    color: "#202124",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 5,
    fontWeight: "600",
    maxWidth: 150,
  },
  input: {
    margin: 8,
    padding: 8,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.foreground,
  },
  colors: { flexDirection: "row", gap: 5, paddingHorizontal: 12, paddingVertical: 8 },
  color: { width: 22, height: 22, borderRadius: 11, borderColor: theme.colors.foreground },
  empty: { color: theme.colors.foregroundMuted, padding: 12, fontSize: 13 },
}));

export function TabGroupItems({ tabKey }: { tabKey: string }) {
  const groups = useTabGroupRow();
  return groups ? <TabGroupItemsInner tabKey={tabKey} /> : null;
}
