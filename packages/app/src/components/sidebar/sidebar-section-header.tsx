import { useMemo, type ReactNode, type Ref } from "react";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DensityIcon } from "@/components/ui/density-icon";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { density } from "@/styles/density";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";

/** A sidebar section label such as "Pinned" or "Workspaces". A section with `onToggle`
 * collapses from its title or row; children sit at the trailing edge as its actions. */
export function SidebarSectionHeader({
  title,
  collapsed,
  onToggle,
  testID,
  children,
  fullRowToggle = false,
  drag,
  isDragging = false,
  dragHandleProps,
}: {
  title: string;
  collapsed?: boolean;
  onToggle?: () => void;
  testID?: string;
  children?: ReactNode;
  fullRowToggle?: boolean;
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  if (fullRowToggle && onToggle) {
    return (
      <FullRowCollapsibleHeader
        title={title}
        collapsed={collapsed ?? false}
        onToggle={onToggle}
        testID={testID}
        drag={drag}
        isDragging={isDragging}
        dragHandleProps={dragHandleProps}
      >
        {children}
      </FullRowCollapsibleHeader>
    );
  }
  return (
    <View style={styles.header}>
      {onToggle ? (
        <CollapsibleTitle
          title={title}
          collapsed={collapsed ?? false}
          onToggle={onToggle}
          testID={testID}
        />
      ) : (
        <Text style={styles.title} testID={testID}>
          {title}
        </Text>
      )}
      {children ? <View style={styles.actions}>{children}</View> : null}
    </View>
  );
}

function FullRowCollapsibleHeader({
  title,
  collapsed,
  onToggle,
  testID,
  children,
  drag,
  isDragging,
  dragHandleProps,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  testID?: string;
  children?: ReactNode;
  drag?: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const {
    role: _role,
    tabIndex: _tabIndex,
    "aria-roledescription": _description,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};

  return (
    <View style={[styles.header, styles.fullRowHeader, isDragging && styles.headerDragging]}>
      <Pressable
        {...dragAttributes}
        {...dragHandleProps?.listeners}
        ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={accessibilityState}
        onPress={isDragging ? undefined : onToggle}
        onLongPress={drag}
        style={fullRowToggleStyle}
        testID={testID}
      />
      <View pointerEvents="none" style={styles.fullRowTitle}>
        <Text style={[styles.title, styles.fullRowTitleText]} numberOfLines={1}>
          {title}
        </Text>
        <DensityIcon
          icon={collapsed ? ChevronRight : ChevronDown}
          size="xs"
          color="foregroundMuted"
        />
      </View>
      {children ? (
        <View pointerEvents="box-none" style={styles.actions}>
          {children}
        </View>
      ) : null}
    </View>
  );
}

function fullRowToggleStyle({ hovered, pressed }: PressableStateCallbackType) {
  return [styles.fullRowToggle, (hovered || pressed) && styles.fullRowToggleActive];
}

function CollapsibleTitle({
  title,
  collapsed,
  onToggle,
  testID,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  testID?: string;
}) {
  const isCompact = useIsCompactFormFactor();
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={onToggle}
      style={styles.toggle}
      testID={testID}
    >
      {({ hovered }) => (
        <>
          <Text style={styles.title}>{title}</Text>
          {hovered || isNative || isCompact ? (
            <DensityIcon
              icon={collapsed ? ChevronRight : ChevronDown}
              size="xs"
              color="foregroundMuted"
            />
          ) : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    minHeight: density.rowHeight,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    // The title lands at spacing[2] to align with the rows' leading icons. Trailing actions
    // are icon buttons whose painted glyph stops inside the SVG box, so 4px aligns the ink
    // rather than the box to the row rail.
    paddingLeft: theme.spacing[2],
    paddingRight: 4,
    userSelect: "none",
  },
  // The toggle reaches back over the header's leading padding so the whole label edge is pressable.
  toggle: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginLeft: -theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  fullRowToggle: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: theme.borderRadius.lg,
  },
  fullRowHeader: {
    borderRadius: theme.borderRadius.lg,
  },
  headerDragging: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    transform: [{ scale: 1.02 }],
    zIndex: 3,
    ...theme.shadow.md,
  },
  fullRowToggleActive: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  fullRowTitle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  fullRowTitleText: {
    flexShrink: 1,
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
