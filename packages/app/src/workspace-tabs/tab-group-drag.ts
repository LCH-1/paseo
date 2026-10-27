import type { InlineListDragItem, InlineListDrop } from "@/components/draggable-list.types";
export const TAB_GROUP_JOIN_DISTANCE = 18;
export const TAB_GROUP_ROW_HEIGHT = 32;
export interface TabGroupDragItem extends InlineListDragItem {
  groupId: string | null;
  header: boolean;
}
interface TabGroupDragInput {
  activeKey: string;
  pointerX: number;
  sourceGroupId: string | null;
  items: TabGroupDragItem[];
}
interface GroupSpan {
  id: string;
  left: number;
  right: number;
}
function distanceToSpan(x: number, span: GroupSpan): number {
  return Math.max(span.left - x, x - span.right, 0);
}
export function resolveTabGroupDrag({
  activeKey,
  pointerX,
  sourceGroupId,
  items,
}: TabGroupDragInput): InlineListDrop {
  const spans = new Map<string, GroupSpan>();
  for (const item of items) {
    if (!item.groupId) continue;
    const span = spans.get(item.groupId);
    if (span) {
      span.left = Math.min(span.left, item.left);
      span.right = Math.max(span.right, item.right);
    } else spans.set(item.groupId, { id: item.groupId, left: item.left, right: item.right });
  }
  const candidates = [...spans.values()].filter(
    (span) =>
      distanceToSpan(pointerX, span) <= (span.id === sourceGroupId ? 0 : TAB_GROUP_JOIN_DISTANCE),
  );
  candidates.sort((a, b) => distanceToSpan(pointerX, a) - distanceToSpan(pointerX, b));
  const groupId = candidates[0]?.id ?? null;
  const targets = items.filter(
    (item) => item.key !== activeKey && (!groupId || item.groupId === groupId),
  );
  targets.sort(
    (a, b) =>
      Math.abs((a.left + a.right) / 2 - pointerX) - Math.abs((b.left + b.right) / 2 - pointerX),
  );
  const target = targets[0];
  if (!target) return { activeKey, overKey: activeKey, groupId, before: false };
  const before =
    target.header && groupId === target.groupId
      ? false
      : pointerX < (target.left + target.right) / 2;
  return { activeKey, overKey: target.key, groupId, before };
}
