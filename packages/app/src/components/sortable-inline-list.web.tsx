import { useCallback, useMemo, useRef, type ReactElement } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  type Modifier,
  type CollisionDetection,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  InlineListDrop,
  InlineListDragPosition,
  DraggableRenderItemInfo,
} from "./draggable-list.types";
import { reorderItemsOnDragEnd, useDragReorderState } from "./drag-reorder";

const restrictToHorizontalAxis: Modifier = ({ transform }) => ({
  ...transform,
  y: 0,
});

const DND_MODIFIERS: Modifier[] = [restrictToHorizontalAxis];

function computeDragOpacity(hasExternalContext: boolean, isDragging: boolean): number {
  if (!isDragging) return 1;
  return hasExternalContext ? 0.3 : 0.9;
}

function SortableItem<T>({
  id,
  item,
  index,
  renderItem,
  activeId,
  useDragHandle,
  disabled,
  itemData,
  externalDndContext,
}: {
  id: string;
  item: T;
  index: number;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  activeId: string | null;
  useDragHandle: boolean;
  disabled: boolean;
  itemData?: Record<string, unknown>;
  externalDndContext: boolean;
}): ReactElement {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled, data: itemData });

  const drag = useCallback(() => {
    // dnd-kit handles drag initiation via listeners
    // This is a no-op but matches the mobile API
  }, []);

  // External DnD contexts render their own insertion affordance, so keep the
  // tab row static and let the DragOverlay carry the moving chip.
  const baseTransform = externalDndContext
    ? undefined
    : CSS.Transform.toString(
        transform && isDragging ? { ...transform, scaleX: 1, scaleY: 1 } : transform,
      );
  const scaleTransform = !externalDndContext && isDragging ? "scale(1.01)" : "";
  const combinedTransform = [baseTransform, scaleTransform].filter(Boolean).join(" ");

  const style = useMemo(
    () => ({
      transform: combinedTransform || undefined,
      transition,
      opacity: computeDragOpacity(Boolean(externalDndContext), isDragging),
      zIndex: isDragging ? 1000 : 1,
    }),
    [combinedTransform, transition, externalDndContext, isDragging],
  );

  const info: DraggableRenderItemInfo<T> = {
    item,
    index,
    drag,
    isActive: activeId === id,
    dragHandleProps: useDragHandle
      ? {
          attributes: attributes as unknown as Record<string, unknown>,
          listeners: listeners as unknown as Record<string, unknown>,
          setActivatorNodeRef: setActivatorNodeRef as unknown as (node: unknown) => void,
        }
      : undefined,
  };

  const wrapperProps = useDragHandle
    ? { ref: setNodeRef }
    : { ref: setNodeRef, ...attributes, ...listeners };

  return (
    <div {...wrapperProps} style={style}>
      {renderItem(info)}
    </div>
  );
}

export function SortableInlineList<T>({
  data,
  keyExtractor,
  renderItem,
  onDragEnd,
  useDragHandle = false,
  disabled = false,
  activationDistance = 8,
  onDragBegin,
  onDragStartKey,
  resolveDrop,
  onDragPreview,
  externalDndContext = false,
  activeId: externalActiveId = null,
  getItemData,
}: {
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  onDragEnd?: (data: T[], drop: InlineListDrop) => void;
  onDragStartKey?: (key: string) => void;
  resolveDrop?: (position: InlineListDragPosition) => InlineListDrop;
  onDragPreview?: (drop: InlineListDrop | null) => void;
  useDragHandle?: boolean;
  disabled?: boolean;
  activationDistance?: number;
  onDragBegin?: () => void;
  externalDndContext?: boolean;
  activeId?: string | null;
  getItemData?: (item: T, index: number) => Record<string, unknown>;
}): ReactElement {
  const {
    activeId: internalActiveId,
    items: managedItems,
    handlers,
  } = useDragReorderState({
    data,
    keyExtractor,
    onDragEnd,
    onDragBegin,
    disabled,
  });
  const latestDrop = useRef<InlineListDrop | null>(null);
  const detectDrop = useCallback<CollisionDetection>(
    (args) => {
      if (!resolveDrop) return closestCenter(args);
      const items = args.droppableContainers.flatMap((container) => {
        const rect = args.droppableRects.get(container.id);
        return rect ? [{ key: String(container.id), left: rect.left, right: rect.right }] : [];
      });
      const drop = resolveDrop({
        activeKey: String(args.active.id),
        pointerX:
          args.pointerCoordinates?.x ?? args.collisionRect.left + args.collisionRect.width / 2,
        dragged: { left: args.collisionRect.left, right: args.collisionRect.right },
        items,
      });
      latestDrop.current = drop;
      const reordered = reorderItemsOnDragEnd({
        items: managedItems,
        activeId: drop.activeKey,
        overId: drop.overKey,
        keyExtractor,
        before: drop.before,
      });
      const index = (reordered ?? managedItems).findIndex(
        (item, i) => keyExtractor(item, i) === drop.activeKey,
      );
      return [{ id: keyExtractor(managedItems[index], index) }];
    },
    [resolveDrop, managedItems, keyExtractor],
  );
  const handleDragMove = useCallback(() => onDragPreview?.(latestDrop.current), [onDragPreview]);
  const handleDragCancel = useCallback(() => {
    latestDrop.current = null;
    onDragPreview?.(null);
    handlers.onDragCancel();
  }, [handlers, onDragPreview]);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const drop = latestDrop.current;
      if (resolveDrop && drop) {
        const reordered = reorderItemsOnDragEnd({
          items: managedItems,
          activeId: drop.activeKey,
          overId: drop.overKey,
          keyExtractor,
          before: drop.before,
        });
        handlers.onDragCancel();
        onDragEnd?.(reordered ?? managedItems, drop);
      } else handlers.onDragEnd(event);
      latestDrop.current = null;
      onDragPreview?.(null);
    },
    [resolveDrop, managedItems, keyExtractor, handlers, onDragEnd, onDragPreview],
  );
  const handleDragStart = useCallback(
    (event: import("@dnd-kit/core").DragStartEvent) => {
      onDragStartKey?.(String(event.active.id));
      handlers.onDragStart(event);
    },
    [onDragStartKey, handlers],
  );
  const items = externalDndContext ? data : managedItems;
  const activeId = externalDndContext ? externalActiveId : internalActiveId;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: activationDistance,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const ids = useMemo(
    () => items.map((item, index) => keyExtractor(item, index)),
    [items, keyExtractor],
  );

  const renderedItems = (
    <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
      {items.map((item, index) => {
        const id = keyExtractor(item, index);
        return (
          <SortableItem
            key={id}
            id={id}
            item={item}
            index={index}
            renderItem={renderItem}
            activeId={activeId}
            useDragHandle={useDragHandle}
            disabled={disabled}
            itemData={getItemData?.(item, index)}
            externalDndContext={externalDndContext}
          />
        );
      })}
    </SortableContext>
  );

  if (externalDndContext) {
    return renderedItems;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={detectDrop}
      modifiers={DND_MODIFIERS}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      {renderedItems}
    </DndContext>
  );
}
