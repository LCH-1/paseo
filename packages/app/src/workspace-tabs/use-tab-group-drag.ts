import { useCallback, useMemo } from "react";
import type { InlineListDragPosition, InlineListDrop } from "@/components/draggable-list.types";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { resolveTabGroupDrag } from "./tab-group-drag";
import { groupForTab, type TabGroup } from "./tab-groups";
import { useTabGroupRow } from "./use-grouped-workspace-tabs";
interface GroupDragRow {
  tab: WorkspaceTabDescriptor;
  groupHeader?: TabGroup;
}
export function useTabGroupDrag<T extends GroupDragRow>(
  rows: T[],
  keyExtractor: (row: T) => string,
) {
  const groups = useTabGroupRow();
  const resolveDrop = useCallback(
    (position: InlineListDragPosition): InlineListDrop => {
      const byKey = new Map(rows.map((row) => [keyExtractor(row), row]));
      const items = position.items.map((item) => {
        const row = byKey.get(item.key)!;
        const groupId =
          row.groupHeader?.id ??
          (groups ? groupForTab(groups.state, row.tab.key)?.id : null) ??
          null;
        return { ...item, groupId, header: Boolean(row.groupHeader) };
      });
      const active = items.find((item) => item.key === position.activeKey)!;
      if (active.header) {
        const targets = items.filter((item) => item.groupId !== active.groupId);
        targets.sort(
          (a, b) =>
            Math.abs((a.left + a.right) / 2 - position.pointerX) -
            Math.abs((b.left + b.right) / 2 - position.pointerX),
        );
        const target = targets[0] ?? active;
        return {
          activeKey: active.key,
          overKey: target.key,
          before: position.pointerX < (target.left + target.right) / 2,
        };
      }
      return resolveTabGroupDrag({ ...position, items, sourceGroupId: active.groupId });
    },
    [rows, keyExtractor, groups],
  );
  const onDragPreview = useCallback(
    (drop: InlineListDrop | null) => {
      const row = rows.find((item) => keyExtractor(item) === drop?.activeKey);
      groups?.preview(
        drop && row && !row.groupHeader
          ? { key: row.tab.key, groupId: drop.groupId ?? null }
          : null,
      );
    },
    [rows, keyExtractor, groups],
  );
  return useMemo(
    () => (groups ? { resolveDrop, onDragPreview } : {}),
    [groups, resolveDrop, onDragPreview],
  );
}
