import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

export const TAB_GROUP_COLORS = {
  grey: "#9aa0a6",
  blue: "#8ab4f8",
  red: "#f28b82",
  yellow: "#fdd663",
  green: "#81c995",
  pink: "#ff8bcb",
  purple: "#c58af9",
  cyan: "#78d9ec",
  orange: "#fcad70",
} as const;
export type TabGroupColor = keyof typeof TAB_GROUP_COLORS;
export interface TabGroup {
  windowKey?: string;
  id: string;
  name: string;
  color: TabGroupColor;
  collapsed: boolean;
  closed: boolean;
  tabs: WorkspaceTabDescriptor[];
}
export interface TabGroupsState {
  groups: TabGroup[];
  order: string[];
}
export const EMPTY_TAB_GROUPS: TabGroupsState = { groups: [], order: [] };
export const GROUP_HEADER_PREFIX = "workspace-tab-group:";
export function groupForTab(state: TabGroupsState, key: string) {
  return state.groups.find((group) => group.tabs.some((tab) => tab.key === key));
}
export function assignToTabGroup(
  state: TabGroupsState,
  id: string,
  tabs: WorkspaceTabDescriptor[],
): TabGroupsState {
  const keys = new Set(tabs.map((tab) => tab.key));
  return {
    ...state,
    groups: state.groups
      .map((group) => {
        const kept = group.tabs.filter((tab) => !keys.has(tab.key));
        return {
          ...group,
          tabs: group.id === id ? [...kept, ...tabs] : kept,
          closed: group.id === id ? false : group.closed,
        };
      })
      .filter((group) => group.tabs.length > 0),
  };
}
export function removeFromTabGroups(state: TabGroupsState, keys: string[]): TabGroupsState {
  const removed = new Set(keys);
  return {
    ...state,
    groups: state.groups
      .map((group) => ({ ...group, tabs: group.tabs.filter((tab) => !removed.has(tab.key)) }))
      .filter((group) => group.tabs.length > 0),
  };
}
export function projectTabGroups<T extends { tab: WorkspaceTabDescriptor }>(
  state: TabGroupsState,
  rows: T[],
  windowKey?: string,
  onlyGroupId?: string | null,
): Array<{ row: T } | { group: TabGroup }> {
  const byKey = new Map(rows.map((row) => [row.tab.key, row]));
  const order = [
    ...state.order.filter((key) => byKey.has(key)),
    ...rows.map((row) => row.tab.key).filter((key) => !state.order.includes(key)),
  ];
  const seen = new Set<string>(),
    result: Array<{ row: T } | { group: TabGroup }> = [];
  for (const key of order) {
    const group = groupForTab(state, key);
    if (!group) {
      if (!onlyGroupId) result.push({ row: byKey.get(key)! });
      continue;
    }
    if (
      (windowKey && group.windowKey && windowKey !== group.windowKey) ||
      (onlyGroupId && group.id !== onlyGroupId)
    )
      continue;
    if (seen.has(group.id) || group.closed) continue;
    seen.add(group.id);
    result.push({ group });
    if (!group.collapsed)
      for (const member of group.tabs) {
        const row = byKey.get(member.key);
        if (row) result.push({ row });
      }
  }
  return result;
}
interface TabGroupDrop {
  overKey: string;
  tab: WorkspaceTabDescriptor;
}
function applyTabGroupDrop(
  state: TabGroupsState,
  visibleKeys: string[],
  movedKey: string,
  drop?: TabGroupDrop,
): TabGroupsState {
  const destinationKey = drop?.overKey ?? visibleKeys[visibleKeys.indexOf(movedKey) - 1];
  const destination = destinationKey?.startsWith(GROUP_HEADER_PREFIX)
    ? state.groups.find((group) => GROUP_HEADER_PREFIX + group.id === destinationKey)
    : groupForTab(state, destinationKey ?? "");
  const source = groupForTab(state, movedKey);
  const moving = drop?.tab ?? source?.tabs.find((tab) => tab.key === movedKey);
  if (!moving || destination?.id === source?.id) return state;
  return destination
    ? assignToTabGroup(state, destination.id, [moving])
    : removeFromTabGroups(state, [movedKey]);
}
/** A header moves its whole block; an individual tab follows its drop destination. */
export function reorderTabGroups(
  state: TabGroupsState,
  visibleKeys: string[],
  movedKey?: string,
  drop?: TabGroupDrop,
): TabGroupsState {
  const movingGroup = state.groups.find((group) => GROUP_HEADER_PREFIX + group.id === movedKey);
  const next =
    movedKey && !movingGroup ? applyTabGroupDrop(state, visibleKeys, movedKey, drop) : state;
  const expanded: string[] = [];
  for (const key of visibleKeys) {
    const group = key.startsWith(GROUP_HEADER_PREFIX)
      ? next.groups.find((candidate) => GROUP_HEADER_PREFIX + candidate.id === key)
      : null;
    if (group) expanded.push(...group.tabs.map((tab) => tab.key));
    else if (!movingGroup?.tabs.some((tab) => tab.key === key)) expanded.push(key);
  }
  const order = [...new Set([...expanded, ...next.order])];
  const positions = new Map(visibleKeys.map((key, index) => [key, index]));
  return {
    ...next,
    order,
    groups: next.groups.map((group) =>
      Object.assign({}, group, {
        tabs: [...group.tabs].sort(
          (left, right) =>
            (positions.get(left.key) ?? Infinity) - (positions.get(right.key) ?? Infinity),
        ),
      }),
    ),
  };
}
