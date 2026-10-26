import { getTabGroupWindow } from "./tab-groups-window";
import { removeFromTabGroups, groupForTab } from "./tab-groups";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { EMPTY_TAB_GROUPS, type TabGroupsState } from "./tab-groups";

export const useTabGroups = create<{
  state: TabGroupsState;
  update: (reduce: (state: TabGroupsState) => TabGroupsState) => void;
}>()(
  persist(
    (set) => ({
      state: EMPTY_TAB_GROUPS,
      update: (reduce) => set((current) => ({ state: reduce(current.state) })),
    }),
    { name: "workspace-tab-groups", storage: createJSONStorage(() => AsyncStorage) },
  ),
);

export function isTabGroupKeyVisible(key: string): boolean {
  const window = getTabGroupWindow(),
    group = groupForTab(useTabGroups.getState().state, key);
  if (window.excludedKeys?.includes(key)) return false;
  return !group?.closed && (!group?.windowKey || group.windowKey === window.key);
}

export function forgetTabGroupKey(key: string): void {
  const state = useTabGroups.getState();
  if (groupForTab(state.state, key)) state.update((current) => removeFromTabGroups(current, [key]));
}
