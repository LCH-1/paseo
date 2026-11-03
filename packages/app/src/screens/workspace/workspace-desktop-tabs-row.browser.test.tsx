import React, { type PropsWithChildren, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { expect, it, vi } from "vitest";
import { RetainedPanel } from "@/components/retained-panel";
import type { DraggableRenderItemInfo, InlineListDrop } from "@/components/draggable-list.types";
import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";
import type { WorkspaceTabPresentation } from "./workspace-tab-presentation";
import {
  WorkspaceDesktopTabsRow,
  type WorkspaceDesktopTabRowItem,
  type WorkspaceDesktopTabsRowProps,
} from "./workspace-desktop-tabs-row";

const fixture = vi.hoisted(() => ({ reorder: () => {} }));

vi.mock("lucide-react-native", () => {
  function Icon() {
    return null;
  }
  return {
    CopyX: Icon,
    ArrowLeftToLine: Icon,
    ArrowRightToLine: Icon,
    Copy: Icon,
    Pencil: Icon,
    RotateCw: Icon,
    Columns2: Icon,
    Rows2: Icon,
    Ellipsis: Icon,
    Maximize: Icon,
    Minimize: Icon,
    Plus: Icon,
    X: Icon,
  };
});
vi.mock("@/components/ui/control-geometry", () => ({ buttonControlHeight: { xs: 28 } }));
vi.mock("@/workspace-tabs/identity", () => ({
  buildDeterministicWorkspaceTabId: (target: WorkspaceTabDescriptor["target"]) => {
    if (target.kind === "file") return `file_${target.path}`;
    if (target.kind === "agent") return `agent_${target.agentId}`;
    return target.kind;
  },
}));
vi.mock("@/keyboard/handler-id", () => ({ buildWorkspaceKeyboardHandlerId: () => "fixture" }));
vi.mock("react-native-reanimated", async () => {
  const { ScrollView } = await import("react-native");
  return { default: { ScrollView } };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
  getIsElectron: () => false,
}));
vi.mock("@/constants/layout", () => ({
  WORKSPACE_SECONDARY_HEADER_HEIGHT: 40,
  useIsCompactFormFactor: () => false,
}));
vi.mock("@/workspace-tabs/use-tab-group-drag", () => ({ useTabGroupDrag: () => ({}) }));
vi.mock("@/workspace-tabs/tab-group-drag", () => ({ TAB_GROUP_ROW_HEIGHT: 34 }));
vi.mock("@/workspace-tabs/tab-group-controls", () => ({
  TabGroupHeader: () => null,
  TabGroupItems: () => null,
  TabGroupUnderline: () => null,
}));
vi.mock("@/workspace-tabs/tab-groups", () => ({ TAB_GROUP_COLORS: [] }));
vi.mock("@/workspace-tabs/use-grouped-workspace-tabs", async () => {
  const { createContext } = await import("react");
  return {
    TabGroupRowContext: createContext(null),
    useTabGroupRow: () => null,
    useGroupedWorkspaceTabs: (
      rowProps: WorkspaceDesktopTabsRowProps,
      resolvedRows: WorkspaceDesktopTabRowItem[],
    ) => ({
      rows: resolvedRows,
      context: { reorder: rowProps.onReorderTabs, closeTab: rowProps.onCloseTab },
    }),
  };
});
vi.mock("@/screens/workspace/workspace-tab-presentation", async () => {
  const { useMemo } = await import("react");
  function Icon() {
    return null;
  }
  return {
    WorkspaceTabIcon: Icon,
    WorkspaceTabPresentationResolver: function Presentation({
      tab,
      children,
    }: {
      tab: WorkspaceTabDescriptor;
      children: (presentation: WorkspaceTabPresentation) => ReactElement;
    }) {
      const presentation = useMemo<WorkspaceTabPresentation>(
        () => ({
          key: tab.key,
          kind: tab.kind,
          label: tab.target.kind === "file" ? tab.target.path : tab.tabId,
          tooltip: tab.tabId,
          subtitle: "",
          modified: false,
          showCloseButton: true,
          titleState: "ready",
          icon: Icon,
          statusBucket: null,
          ...(tab.target.kind === "agent"
            ? { titleLines: { primaryLabel: "Project", secondaryLabel: tab.tabId } }
            : {}),
        }),
        [tab],
      );
      return children(presentation);
    },
  };
});
vi.mock("@/components/sortable-inline-list", () => ({
  SortableInlineList: function Sortable({
    data,
    renderItem,
    onDragEnd,
  }: {
    data: WorkspaceDesktopTabRowItem[];
    renderItem: (input: DraggableRenderItemInfo<WorkspaceDesktopTabRowItem>) => ReactElement;
    onDragEnd: (rows: WorkspaceDesktopTabRowItem[], drop: InlineListDrop) => void;
  }) {
    fixture.reorder = () =>
      onDragEnd(data.toReversed(), { activeKey: data[0].tab.key, overKey: data[2].tab.key });
    return (
      <>
        {data.map((item, index) => (
          <React.Fragment key={item.tab.key}>
            {renderItem({ item, index, isActive: false, drag: () => {} })}
          </React.Fragment>
        ))}
      </>
    );
  },
}));
vi.mock("@/screens/workspace/workspace-tab-menu", () => ({
  buildWorkspaceDesktopTabActions: ({ tab }: { tab: WorkspaceTabDescriptor }) => ({
    menuEntries: [],
    closeButtonTestId: `fixture-close-${tab.tabId}`,
    contextMenuTestId: "fixture-menu",
  }),
}));
vi.mock("@/components/ui/context-menu", async () => {
  const { Pressable } = await import("react-native");
  return {
    ContextMenu: ({ children }: PropsWithChildren) => children,
    ContextMenuTrigger: Pressable,
    ContextMenuContent: () => null,
    ContextMenuItem: () => null,
    ContextMenuSeparator: () => null,
  };
});
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => children,
  TooltipTrigger: ({ children }: PropsWithChildren) => children,
  TooltipContent: () => null,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: () => null,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
}));
vi.mock("@/components/ui/pane-content-toolbar", () => ({
  paneContentToolbarTrailingPadding: () => 0,
  ToolbarButton: () => null,
  ToolbarControls: ({ children }: PropsWithChildren) => children,
}));
vi.mock("@/components/ui/icon-button-chrome", () => ({ smallIconButtonChromeFrameSize: () => 20 }));
vi.mock("@/screens/workspace/workspace-new-tab-menu", () => ({
  WorkspaceNewTabMenuContent: () => null,
}));
vi.mock("@/hooks/use-shortcut-keys", () => ({ useShortcutKeys: () => null }));
vi.mock("@/hooks/use-keyboard-action-handler", () => ({ useKeyboardActionHandler: () => {} }));
vi.mock("@/hooks/use-time-ago", () => ({
  useCompactTimeAgo: () => null,
  useCompletionTimeAgo: () => "0m",
}));
vi.mock("@/utils/time", () => ({ formatCompactTimeAgoAsProse: () => "" }));
vi.mock("@/stores/session-store", () => ({ useSessionStore: () => null }));
vi.mock("@/utils/render-profiler", () => ({
  RenderProfile: ({ children }: PropsWithChildren) => children,
}));
vi.mock("@/components/ui/horizontal-scroll-boundary", () => ({
  HorizontalScrollBoundaryShades: () => null,
  useHorizontalScrollBoundary: () => ({}),
}));
vi.mock("@/components/ui/trailing-action-scrim", () => ({ TrailingActionScrim: () => null }));
vi.mock("@/components/ui/shortcut", () => ({ Shortcut: () => null }));
vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => null }));

function rows(labels: string[]): WorkspaceDesktopTabRowItem[] {
  return labels.map((path, index) => ({
    tab: {
      key: `file-${index}`,
      tabId: `file-${index}`,
      kind: "file",
      target: { kind: "file", path },
    },
    isActive: index === 0,
    isCloseHovered: false,
    isClosingTab: false,
  }));
}

function props(tabs: WorkspaceDesktopTabRowItem[]): WorkspaceDesktopTabsRowProps {
  const noop = () => {};
  return {
    tabs,
    normalizedServerId: "fixture",
    normalizedWorkspaceId: "workspace",
    host: "explorer",
    setHoveredCloseTabKey: noop,
    onNavigateTab: noop,
    onCloseTab: noop,
    onCopyResumeCommand: noop,
    onCopyAgentId: noop,
    onCopyTerminalId: noop,
    onCopyFilePath: noop,
    onReloadAgent: noop,
    onRenameTab: noop,
    onCloseTabsToLeft: noop,
    onCloseTabsToRight: noop,
    onCloseOtherTabs: noop,
    onCreateNewTab: noop,
    onReorderTabs: noop,
    focusModeEnabled: false,
    onExitFocusMode: noop,
  };
}

function chips(host: HTMLElement): HTMLElement[] {
  return Array.from(
    host.querySelectorAll<HTMLElement>(
      '[data-testid^="workspace-tab-file_"],[data-testid^="workspace-tab-agent_"]',
    ),
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function firstFrames(host: HTMLElement): Promise<number[]> {
  const counts: number[] = [];
  for (let frame = 0; frame < 3; frame++) {
    await nextFrame();
    counts.push(chips(host).length);
  }
  return counts;
}

it("paints measured tabs immediately and retains them through the first returned frames", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:1000px;height:100px";
  document.body.appendChild(host);
  const root = createRoot(host);
  const tabProps = props(rows(["one.txt", "two.txt", "three.txt"]));
  tabProps.tabs = tabProps.tabs.map((row, index) => ({
    ...row,
    tab: { ...row.tab, kind: "agent", target: { kind: "agent", agentId: `agent-${index}` } },
  }));
  function render(active: boolean) {
    flushSync(() =>
      root.render(
        <RetainedPanel active={active}>
          <WorkspaceDesktopTabsRow {...tabProps} />
        </RetainedPanel>,
      ),
    );
  }
  try {
    render(true);
    expect(chips(host)).toHaveLength(3);
    expect(await firstFrames(host)).toEqual([3, 3, 3]);
    const firstChip = chips(host)[0];
    const width = firstChip.getBoundingClientRect().width;
    expect(width).toBeGreaterThan(0);
    render(false);
    await firstFrames(host);
    expect(firstChip.getBoundingClientRect().width).toBe(0);
    render(true);
    expect(await firstFrames(host)).toEqual([3, 3, 3]);
    expect(chips(host)[0]).toBe(firstChip);
    expect(firstChip.getBoundingClientRect().width).toBe(width);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});

it("keeps the last positive track while hidden and measures changed titles before revealing it", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:1000px;height:100px";
  document.body.appendChild(host);
  const root = createRoot(host);
  const original = ["one.txt", "two.txt", "three.txt"];
  const changed = [
    "first-much-longer-file-name.txt",
    "second-much-longer-file-name.txt",
    "third-much-longer-file-name.txt",
  ];
  let tabProps = props(rows(original));
  function render(active: boolean) {
    flushSync(() =>
      root.render(
        <RetainedPanel active={active}>
          <WorkspaceDesktopTabsRow {...tabProps} />
        </RetainedPanel>,
      ),
    );
  }
  try {
    render(true);
    await firstFrames(host);
    const originalWidths = chips(host).map((chip) => getComputedStyle(chip).width);
    expect(chips(host).every((chip) => chip.getBoundingClientRect().width > 0)).toBe(true);
    render(false);
    await firstFrames(host);
    host.style.width = "260px";
    tabProps = { ...tabProps, tabs: rows(changed) };
    render(false);
    await firstFrames(host);
    expect(chips(host).map((chip) => chip.textContent)).toEqual(original);
    expect(chips(host).map((chip) => chip.getBoundingClientRect().width)).toEqual([0, 0, 0]);
    expect(chips(host).map((chip) => getComputedStyle(chip).width)).toEqual(originalWidths);
    render(true);
    expect(chips(host).map((chip) => chip.textContent)).toEqual(changed);
    expect(chips(host).map((chip) => chip.getBoundingClientRect().width)).toEqual([69, 69, 69]);
    expect(await firstFrames(host)).toEqual([3, 3, 3]);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});

it("still reacts to rendered font geometry changes through onLayout", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:1000px;height:100px";
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        <RetainedPanel active>
          <WorkspaceDesktopTabsRow {...props(rows(["readme.md"]))} />
        </RetainedPanel>,
      ),
    );
    await firstFrames(host);
    const width = chips(host)[0].getBoundingClientRect().width;
    expect(width).toBeGreaterThan(64);
    expect(width).toBeLessThan(160);
    const measurement = host.querySelector('[data-testid="workspace-tabs-row"]')?.firstElementChild
      ?.firstElementChild;
    if (!(measurement instanceof HTMLElement)) throw Error("Label measurement did not mount");
    measurement.style.fontSize = "32px";
    await vi.waitFor(() => expect(chips(host)[0].getBoundingClientRect().width).toBe(160));
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});

it("remeasures long labels on resize and preserves ordering, navigation, close and reorder actions", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:260px;height:100px";
  document.body.appendChild(host);
  const root = createRoot(host);
  const tabProps = props(
    rows([
      "very-long-first-file-name.txt",
      "very-long-second-file-name.txt",
      "very-long-third-file-name.txt",
    ]),
  );
  tabProps.onNavigateTab = vi.fn();
  tabProps.onCloseTab = vi.fn();
  tabProps.onReorderTabs = vi.fn();
  try {
    flushSync(() =>
      root.render(
        <RetainedPanel active>
          <WorkspaceDesktopTabsRow {...tabProps} />
        </RetainedPanel>,
      ),
    );
    expect(chips(host).map((chip) => chip.getBoundingClientRect().width)).toEqual([69, 69, 69]);
    expect(await firstFrames(host)).toEqual([3, 3, 3]);
    host.style.width = "1000px";
    await vi.waitFor(() =>
      expect(chips(host).map((chip) => chip.getBoundingClientRect().width)).toEqual([
        160, 160, 160,
      ]),
    );
    expect(chips(host).map((chip) => chip.textContent)).toEqual(
      tabProps.tabs.map((row) => (row.tab.target.kind === "file" ? row.tab.target.path : "")),
    );
    flushSync(() => chips(host)[1].click());
    expect(tabProps.onNavigateTab).toHaveBeenCalledExactlyOnceWith("file-1");
    const close = host.querySelector<HTMLElement>('[data-testid="fixture-close-file-1"]');
    if (!close) throw Error("Close action did not mount");
    flushSync(() => close.click());
    expect(tabProps.onCloseTab).toHaveBeenCalledExactlyOnceWith("file-1");
    fixture.reorder();
    expect(tabProps.onReorderTabs).toHaveBeenCalledExactlyOnceWith(
      tabProps.tabs.map((row) => row.tab).toReversed(),
    );
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});
