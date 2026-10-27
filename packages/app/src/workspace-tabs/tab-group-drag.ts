import type {
  InlineListDragBounds,
  InlineListDragItem,
  InlineListDrop,
} from "@/components/draggable-list.types";
export const TAB_GROUP_JOIN_DISTANCE = 12;
export const TAB_GROUP_LEAVE_DISTANCE = 8;
export const TAB_GROUP_ROW_HEIGHT = 32;
export interface TabGroupDragItem extends InlineListDragItem {
  groupId: string | null;
  header: boolean;
}
interface TabGroupDragInput {
  activeKey: string;
  pointerX: number;
  dragged: InlineListDragBounds;
  sourceGroupId: string | null;
  items: TabGroupDragItem[];
}
interface GroupSpan extends InlineListDragBounds {
  id: string;
}
function groupSpans(items: TabGroupDragItem[], membersOnly = false): GroupSpan[] {
  const spans = new Map<string, GroupSpan>();
  for (const item of items) {
    if (!item.groupId || (membersOnly && item.header)) continue;
    const span = spans.get(item.groupId);
    if (span) {
      span.left = Math.min(span.left, item.left);
      span.right = Math.max(span.right, item.right);
    } else spans.set(item.groupId, { id: item.groupId, left: item.left, right: item.right });
  }
  return [...spans.values()];
}
function distanceBetween(left: InlineListDragBounds, right: InlineListDragBounds): number {
  return Math.max(left.left - right.right, right.left - left.right, 0);
}
function center(rect: InlineListDragBounds): number {
  return (rect.left + rect.right) / 2;
}
function exitSide(
  source: GroupSpan | undefined,
  dragged: InlineListDragBounds,
): "left" | "right" | null {
  if (!source) return null;
  if (dragged.left < source.left - TAB_GROUP_LEAVE_DISTANCE) return "left";
  if (dragged.right > source.right + TAB_GROUP_LEAVE_DISTANCE) return "right";
  return null;
}
function nearbyGroup(input: TabGroupDragInput, initial: TabGroupDragItem): string | null {
  const approaching = groupSpans(input.items).filter(
    (span) =>
      span.id !== input.sourceGroupId &&
      Math.abs(center(input.dragged) - center(span)) < Math.abs(center(initial) - center(span)),
  );
  const candidates = approaching.filter(
    (span) => distanceBetween(input.dragged, span) <= TAB_GROUP_JOIN_DISTANCE,
  );
  candidates.sort(
    (a, b) =>
      distanceBetween(input.dragged, a) - distanceBetween(input.dragged, b) ||
      Math.abs(center(input.dragged) - center(a)) - Math.abs(center(input.dragged) - center(b)),
  );
  return candidates[0]?.id ?? null;
}
function outsideTarget(input: TabGroupDragInput, side: "left" | "right"): InlineListDrop {
  const source = input.items.filter(
    (item) => item.groupId === input.sourceGroupId && item.key !== input.activeKey,
  );
  const target = side === "left" ? source[0] : source[source.length - 1];
  return {
    activeKey: input.activeKey,
    overKey: target.key,
    groupId: null,
    before: side === "left",
  };
}
export function resolveTabGroupDrag(input: TabGroupDragInput): InlineListDrop {
  const { activeKey, dragged, sourceGroupId, items } = input;
  const initial = items.find((item) => item.key === activeKey)!;
  const source = groupSpans(items, true).find((span) => span.id === sourceGroupId);
  const side = exitSide(source, dragged);
  const retained = source && !side;
  const groupId = retained ? sourceGroupId : nearbyGroup(input, initial);
  if (!groupId && side) return outsideTarget(input, side);
  const targets = items.filter(
    (item) => item.key !== activeKey && (!groupId || item.groupId === groupId),
  );
  const x = center(dragged);
  targets.sort((a, b) => Math.abs(center(a) - x) - Math.abs(center(b) - x));
  const target = targets[0];
  if (!target) return { activeKey, overKey: activeKey, groupId, before: false };
  const before = target.header && groupId === target.groupId ? false : x < center(target);
  return { activeKey, overKey: target.key, groupId, before };
}
