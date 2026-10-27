import { arrayMove } from "@dnd-kit/sortable";

export interface DragEndInput<T> {
  items: T[];
  activeId: string;
  overId: string | null | undefined;
  keyExtractor: (item: T, index: number) => string;
  before?: boolean;
}

export function reorderItemsOnDragEnd<T>({
  items,
  activeId,
  overId,
  keyExtractor,
  before,
}: DragEndInput<T>): T[] | null {
  if (!overId || activeId === overId) return null;

  const oldIndex = items.findIndex((item, i) => keyExtractor(item, i) === activeId);
  const newIndex = items.findIndex((item, i) => keyExtractor(item, i) === overId);

  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return null;

  if (before !== undefined) {
    const remaining = items.filter((_, index) => index !== oldIndex);
    const target = remaining.findIndex((item, index) => keyExtractor(item, index) === overId);
    remaining.splice(target + (before ? 0 : 1), 0, items[oldIndex]);
    return remaining;
  }
  return arrayMove(items, oldIndex, newIndex);
}
