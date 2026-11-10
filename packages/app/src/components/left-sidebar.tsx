import type { SidebarHostProjectGroup } from "@/components/sidebar/host-project-groups";
import { SidebarCollapseAllHostsButton } from "@/components/sidebar/sidebar-collapse-actions";
import { FolderPlus, GitBranch, X, type LucideIcon } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Pressable,
  StyleSheet as RNStyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import {
  IconButtonChromeProvider,
  iconButtonChromeGlyphSize,
  mutedIconColorMapping,
} from "@/components/ui/icon-button-chrome";
import { resolveDesktopSidebarWidth } from "@/components/desktop-sidebar-layout";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { SidebarDisplayPreferencesMenu } from "@/components/sidebar/display-preferences/menu";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { getProjectWindowScope } from "@/project-window/state";
import { SidebarNavRows } from "@/components/sidebar/sidebar-nav-rows";
import { SidebarActivityPanel } from "@/components/sidebar/activity/panel";
import { SidebarFooterIconHighlight } from "@/components/sidebar/sidebar-footer-icon-highlight";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { DensityIcon } from "@/components/ui/density-icon";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HEADER_INNER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useImportSession } from "@/hooks/use-import-session";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import {
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { density } from "@/styles/density";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import type { PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { RetainedPanelActivity } from "@/components/retained-panel";
import type { SidebarWorkspaceGroup } from "@/components/sidebar/sidebar-labels";
import type { SidebarProjectIconTarget } from "@/utils/sidebar-project-row-model";
import { type SidebarGroupMode, useSidebarViewStore } from "@/stores/sidebar-view-store";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { usePanelStore } from "@/stores/panel-store";
import { useOwnsWindowChromeCorner, WindowChromeSafeArea } from "@/utils/desktop-window";
import { useCloseAgentListGesture } from "@/mobile-panels/gestures";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { UsageSidebarItem, UsageSidebarRoot } from "@/usage";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { SidebarCalloutSlot } from "./sidebar-callout-slot";
import { SidebarWorkspaceList } from "./sidebar-workspace-list";

const ThemedX = withUnistyles(X);

type SidebarTheme = ReturnType<typeof useUnistyles>["theme"];

const DEV_BUILD_LABEL = process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL?.trim() || null;

interface SidebarSharedProps {
  theme: SidebarTheme;
  workspaceGroups: SidebarWorkspaceGroup[];
  hostGroups: SidebarHostProjectGroup[];
  projectIconTargets: SidebarProjectIconTarget[];
  pinnedGroups: PinnedSidebarGroups;
  projects: SidebarProjectEntry[];
  hasProjectsBeforeFilter: boolean;
  hasActiveProjectFilter: boolean;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  isManualRefresh: boolean;
  groupMode: SidebarGroupMode;
  collapsedProjectKeys: ReadonlySet<string>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  handleRefresh: () => void;
  handleOpenProject: () => void;
  handleImportSession: () => void;
  labels: SidebarLabels;
}

interface SidebarLabels {
  addProject: string;
  closeSidebar: string;
}

interface MobileSidebarProps extends SidebarSharedProps {
  active: boolean;
  insetsTop: number;
  insetsBottom: number;
  closeSidebar: () => void;
}

interface DesktopSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  active: boolean;
}

export const LeftSidebar = memo(function LeftSidebar({ active }: { active: boolean }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompactLayout = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);

  const {
    projects,
    hasProjectsBeforeFilter,
    resolvedProjectFilters,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    refreshAll,
    workspaceGroups,
    hostGroups,
    projectIconTargets,
    pinnedGroups,
    collapsedProjectKeys,
    toggleProjectCollapsed,
    groupMode,
    shortcutModel,
  } = useSidebarModel();
  const { shortcutIndexByWorkspaceKey } = shortcutModel;

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!isRevalidating && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isRevalidating, isManualRefresh]);

  const openProjectPicker = useOpenAddProject();
  const { open: openImportSession, sheet: importSessionSheet } = useImportSession();

  const handleOpenProjectMobile = useCallback(() => {
    showMobileAgent();
    void openProjectPicker();
  }, [showMobileAgent, openProjectPicker]);

  const handleOpenProjectDesktop = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleImportSessionMobile = useCallback(() => {
    showMobileAgent();
    openImportSession();
  }, [openImportSession, showMobileAgent]);

  const labels = useMemo(
    (): SidebarLabels => ({
      addProject: t("sidebar.actions.addProject"),
      closeSidebar: t("sidebar.actions.closeSidebar"),
    }),
    [t],
  );

  const sharedProps = {
    theme,
    workspaceGroups,
    hostGroups,
    projectIconTargets,
    pinnedGroups,
    projects,
    hasProjectsBeforeFilter,
    hasActiveProjectFilter: resolvedProjectFilters.length > 0,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    isManualRefresh,
    groupMode,
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey,
    toggleProjectCollapsed,
    handleRefresh,
    labels,
  };

  if (isCompactLayout) {
    return (
      <>
        <RetainedPanelActivity active={active}>
          <MobileSidebar
            {...sharedProps}
            active={active}
            insetsTop={insets.top}
            insetsBottom={insets.bottom}
            closeSidebar={showMobileAgent}
            handleOpenProject={handleOpenProjectMobile}
            handleImportSession={handleImportSessionMobile}
          />
        </RetainedPanelActivity>
        {importSessionSheet}
      </>
    );
  }

  return (
    <>
      <RetainedPanelActivity active={active}>
        <DesktopSidebar
          {...sharedProps}
          insetsTop={insets.top}
          active={active}
          handleOpenProject={handleOpenProjectDesktop}
          handleImportSession={openImportSession}
        />
      </RetainedPanelActivity>
      {importSessionSheet}
    </>
  );
});

function FooterIconButton({
  buttonRef,
  onPress,
  testID,
  label,
  icon,
  iconSizeAdjustment = 0,
  shortcutKeys,
}: {
  onPress: () => void;
  testID: string;
  label: string;
  icon: LucideIcon;
  /** Only for a glyph that reads larger than the others at the same size. */
  iconSizeAdjustment?: number;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
  buttonRef?: RefObject<View | null>;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          ref={buttonRef}
          style={styles.footerIconButton}
          testID={testID}
          nativeID={testID}
          collapsable={false}
          accessible
          accessibilityLabel={label}
          accessibilityRole="button"
          onPress={onPress}
        >
          {({ hovered, pressed }) => (
            <>
              <SidebarFooterIconHighlight visible={pressed} />
              <DensityIcon
                icon={icon}
                size="md"
                sizeAdjustment={iconSizeAdjustment}
                color={hovered ? "foreground" : "foregroundMuted"}
              />
            </>
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8} testID={`${testID}-tooltip`}>
        <IconTooltipContent label={label} shortcutKeys={shortcutKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

function IconTooltipContent({
  label,
  shortcutKeys,
}: {
  label: string;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {shortcutKeys ? <Shortcut chord={shortcutKeys} /> : null}
    </View>
  );
}

function SidebarFooter({
  handleOpenProject,
  labels,
  onBeforeNavigate,
}: {
  handleOpenProject: () => void;
  labels: { addProject: string };
  onBeforeNavigate?: () => void;
}) {
  const newAgentKeys = useShortcutKeys("new-agent");
  const { items } = useSidebarNavItems("footer");
  const rowsRef = useRef<View | null>(null);
  const plugins = items.filter((item) => item.visible && item.kind === "plugin");
  return (
    <UsageSidebarRoot>
      <View style={styles.footerContainer} testID="sidebar-footer">
        {plugins.length ? (
          <View ref={rowsRef} collapsable={false} style={styles.footerRows}>
            {plugins.map((item) =>
              item.kind === "plugin" ? (
                <PluginSidebarItem
                  key={item.key}
                  group={item.group}
                  section="footer"
                  fallbackAnchorRef={rowsRef}
                  onBeforeNavigate={onBeforeNavigate}
                />
              ) : null,
            )}
          </View>
        ) : null}
        <View style={styles.sidebarFooter} testID="sidebar-footer-bottom-line">
          <FooterIconButton
            onPress={handleOpenProject}
            testID="sidebar-add-project"
            label={labels.addProject}
            icon={FolderPlus}
            shortcutKeys={newAgentKeys}
          />
          <View style={styles.footerUsage}>
            <UsageSidebarItem />
          </View>
        </View>
      </View>
    </UsageSidebarRoot>
  );
}

function MobileSidebar({
  active,
  theme,
  workspaceGroups,
  hostGroups,
  projectIconTargets,
  pinnedGroups,
  projects,
  hasProjectsBeforeFilter,
  hasActiveProjectFilter,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleOpenProject,
  handleImportSession,
  labels,
  insetsTop,
  insetsBottom,
  closeSidebar,
}: MobileSidebarProps) {
  const isProjectWindow = getProjectWindowScope() !== null;
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture();

  const handleWorkspacePress = useCallback(() => {
    closeSidebar();
  }, [closeSidebar]);

  const closeButton = useMemo(
    () => <SidebarCloseButton label={labels.closeSidebar} onPress={closeSidebar} />,
    [labels.closeSidebar, closeSidebar],
  );

  const mobileSidebarInsetStyle = useMemo(
    () => ({
      paddingTop: insetsTop,
      paddingBottom: insetsBottom,
      backgroundColor: theme.colors.surfaceSidebar,
    }),
    [insetsTop, insetsBottom, theme.colors.surfaceSidebar],
  );

  const navigationTrailing = useMemo(
    () => (
      <View style={styles.workspaceActions}>
        {workspaceActionsElement}
        {closeButton}
      </View>
    ),
    [closeButton],
  );

  return (
    <MobilePanelOverlay
      panel="agent-list"
      closeGesture={closeGesture}
      panelStyle={mobileSidebarInsetStyle}
    >
      <View style={styles.sidebarContent} pointerEvents="auto">
        <WindowChromeSafeArea placement="below" />
        <SidebarNavRows
          style={styles.sidebarHeaderGroup}
          onBeforeNavigate={closeSidebar}
          firstRowTrailing={navigationTrailing}
        />

        <SidebarActivityPanel active={active} onSessionPress={handleWorkspacePress}>
          {isInitialLoad && !hasActiveHostFilter ? (
            <SidebarAgentListSkeleton />
          ) : (
            <SidebarWorkspaceList
              collapsedProjectKeys={collapsedProjectKeys}
              onToggleProjectCollapsed={toggleProjectCollapsed}
              shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
              groupMode={groupMode}
              workspaceGroups={workspaceGroups}
              hostGroups={hostGroups}
              projectIconTargets={projectIconTargets}
              pinnedGroups={pinnedGroups}
              projects={projects}
              hasProjectsBeforeFilter={hasProjectsBeforeFilter}
              hasActiveProjectFilter={hasActiveProjectFilter}
              workspaceEntriesByKey={workspaceEntriesByKey}
              isRefreshing={isManualRefresh && isRevalidating}
              onRefresh={handleRefresh}
              onWorkspacePress={handleWorkspacePress}
              onAddProject={handleOpenProject}
              onImportSession={handleImportSession}
              parentGestureRef={closeGestureRef}
              dragGestureHostActive={active}
              listHeaderComponent={isProjectWindow ? null : workspacesSectionHeaderElement}
            />
          )}
        </SidebarActivityPanel>
        <SidebarFooter
          handleOpenProject={handleOpenProject}
          labels={labels}
          onBeforeNavigate={closeSidebar}
        />
      </View>
    </MobilePanelOverlay>
  );
}

const NO_SHORTCUT: ShortcutKey[] = [];

/** The compact header's icon button, so the sidebar's close reads like the header it covers. */
function SidebarCloseButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <IconButtonChromeProvider value="header-island">
      <HeaderToggleButton
        onPress={onPress}
        tooltipLabel={label}
        tooltipKeys={NO_SHORTCUT}
        tooltipSide="bottom"
        style={styles.mobileCloseButton}
        testID="sidebar-close"
        nativeID="sidebar-close"
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <ThemedX
          size={iconButtonChromeGlyphSize("large")}
          strokeWidth={1.5}
          uniProps={mutedIconColorMapping}
        />
      </HeaderToggleButton>
    </IconButtonChromeProvider>
  );
}

function DesktopSidebar({
  theme,
  workspaceGroups,
  hostGroups,
  projectIconTargets,
  pinnedGroups,
  projects,
  hasProjectsBeforeFilter,
  hasActiveProjectFilter,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleOpenProject,
  handleImportSession,
  labels,
  insetsTop,
  active,
}: DesktopSidebarProps) {
  const isProjectWindow = getProjectWindowScope() !== null;
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const setSidebarWidth = usePanelStore((state) => state.setSidebarWidth);
  const { width: viewportWidth } = useWindowDimensions();
  const visibleSidebarWidth = resolveDesktopSidebarWidth({
    requestedWidth: sidebarWidth,
    viewportWidth,
  });

  const startWidthRef = useRef(visibleSidebarWidth);
  const resizeWidth = useSharedValue(visibleSidebarWidth);
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizeWidth.value = visibleSidebarWidth;
  }, [resizeWidth, visibleSidebarWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        // Horizontal intent only, so a finger dragging down the touch grip scrolls
        // the workspace list instead of resizing. Anchoring the start width to the
        // activation translation keeps the extra threshold from jumping the edge.
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          startWidthRef.current = visibleSidebarWidth - event.translationX;
          resizeWidth.value = visibleSidebarWidth;
        })
        .onUpdate((event) => {
          // Dragging right (positive translationX) increases width
          const newWidth = startWidthRef.current + event.translationX;
          resizeWidth.value = resolveDesktopSidebarWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
        })
        .onEnd(() => {
          runOnJS(setSidebarWidth)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      hideResizeGrip,
      resizeWidth,
      setSidebarWidth,
      showResizeGrip,
      viewportWidth,
      visibleSidebarWidth,
    ],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));

  const desktopSidebarStyle = useMemo(
    () => [
      staticStyles.desktopSidebar,
      !active && staticStyles.desktopSidebarHidden,
      resizeAnimatedStyle,
    ],
    [active, resizeAnimatedStyle],
  );
  const desktopSidebarBorderStyle = useMemo(
    () => [styles.desktopSidebarBorder, { flex: 1, paddingTop: insetsTop }],
    [insetsTop],
  );
  const sidebarHeaderGroupStyle = useMemo(
    () => [styles.sidebarHeaderGroup, ownsTopLeft && styles.sidebarHeaderGroupBelowChrome],
    [ownsTopLeft],
  );
  return (
    <Animated.View
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      pointerEvents={active ? "auto" : "none"}
      style={desktopSidebarStyle}
    >
      <View style={desktopSidebarBorderStyle}>
        <View style={styles.sidebarDragArea}>
          {ownsTopLeft || DEV_BUILD_LABEL ? (
            <View style={styles.desktopChromeRow}>
              <TitlebarDragRegion />
              {DEV_BUILD_LABEL ? (
                <View
                  pointerEvents="none"
                  style={styles.devBuildBadge}
                  testID="dev-build-label"
                  accessibilityLabel={`Development build: ${DEV_BUILD_LABEL}`}
                >
                  <GitBranch size={12} color={theme.colors.accentForeground} />
                  <Text numberOfLines={1} ellipsizeMode="tail" style={styles.devBuildBadgeText}>
                    {DEV_BUILD_LABEL}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : (
            <TitlebarDragRegion />
          )}
          <SidebarNavRows
            style={sidebarHeaderGroupStyle}
            firstRowTrailing={workspaceActionsElement}
          />
        </View>

        <SidebarActivityPanel active={active}>
          {isInitialLoad && !hasActiveHostFilter ? (
            <SidebarAgentListSkeleton />
          ) : (
            <SidebarWorkspaceList
              collapsedProjectKeys={collapsedProjectKeys}
              onToggleProjectCollapsed={toggleProjectCollapsed}
              shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
              groupMode={groupMode}
              workspaceGroups={workspaceGroups}
              hostGroups={hostGroups}
              projectIconTargets={projectIconTargets}
              pinnedGroups={pinnedGroups}
              projects={projects}
              hasProjectsBeforeFilter={hasProjectsBeforeFilter}
              hasActiveProjectFilter={hasActiveProjectFilter}
              workspaceEntriesByKey={workspaceEntriesByKey}
              isRefreshing={isManualRefresh && isRevalidating}
              onRefresh={handleRefresh}
              onAddProject={handleOpenProject}
              onImportSession={handleImportSession}
              listHeaderComponent={isProjectWindow ? null : workspacesSectionHeaderElement}
            />
          )}
        </SidebarActivityPanel>
        <SidebarCalloutSlot />

        <SidebarFooter handleOpenProject={handleOpenProject} labels={labels} />

        <SidebarResizeHandle
          edge="right"
          gesture={resizeGesture}
          pressed={resizePressed}
          testID="left-sidebar-resize-handle"
        />
      </View>
    </Animated.View>
  );
}

function WorkspaceActions() {
  return (
    <View style={styles.workspaceActions} testID="sidebar-workspace-actions">
      <SidebarCollapseAllHostsButton />
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <View>
            <SidebarDisplayPreferencesMenu />
          </View>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <IconTooltipContent label="메뉴 및 설정" />
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

const workspaceActionsElement = <WorkspaceActions />;

const workspacesSectionHeaderElement = <SidebarSectionHeader title="Workspaces" />;

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const staticStyles = RNStyleSheet.create({
  desktopSidebar: {
    position: "relative" as const,
  },
  desktopSidebarHidden: {
    display: "none",
  },
});

const styles = StyleSheet.create((theme) => ({
  workspaceActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  sidebarHeaderGroup: {
    paddingTop: theme.spacing[2],
    gap: 2,
    paddingBottom: 2,
  },
  sidebarHeaderGroupBelowChrome: {
    paddingTop: 0,
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
  },
  mobileCloseButton: {
    marginRight: theme.spacing[2],
  },
  desktopSidebarBorder: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  sidebarDragArea: {
    position: "relative",
  },
  desktopChromeRow: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: "transparent",
  },
  devBuildBadge: {
    maxWidth: "60%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  devBuildBadgeText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  footerContainer: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  // Buttons sit edge to edge; their own inset spaces the glyphs.
  sidebarFooter: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  footerUsage: {
    minWidth: 0,
    flex: 1,
  },
  // Usage and plugin rows sit above the footer's icon line, spaced like the header nav rows.
  footerRows: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    gap: 2,
  },
  footerIconButton: {
    width: density.iconButton,
    height: density.iconButton,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
