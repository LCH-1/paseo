import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { ExplorerSidebarDock } from "./explorer-sidebar";

const lifetime = vi.hoisted(() => ({ mounts: 0, cleanups: 0 }));
vi.mock("@/components/desktop/titlebar-drag-region", () => ({ TitlebarDragRegion: () => null }));
vi.mock("@/screens/workspace/workspace-desktop-tabs-row", () => ({
  WorkspaceDesktopTabsRow: () => null,
}));
vi.mock("@/screens/workspace/workspace-pane-state", () => ({
  deriveWorkspacePaneState: () => ({ tabs: [], activeTabId: null }),
}));
vi.mock("@/utils/desktop-window", () => ({
  WindowChromeRegion: ({ children }: { children: React.ReactNode }) => children,
  WindowChromeSafeArea: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/screens/workspace/workspace-panel-host", () => ({
  WorkspacePanelHost: function RetainedTree({ isPaneFocused }: { isPaneFocused: boolean }) {
    const active = useRetainedPanelActive();
    const [expanded, setExpanded] = React.useState(false);
    const expand = React.useCallback(() => setExpanded(true), []);
    React.useEffect(() => {
      lifetime.mounts++;
      return () => {
        lifetime.cleanups++;
      };
    }, []);
    return (
      <button
        type="button"
        data-testid="retained-tree"
        data-active={active}
        data-focused={isPaneFocused}
        onClick={expand}
      >
        {expanded ? "Expanded folder" : "Closed folder"}
      </button>
    );
  },
}));

function noop() {}
function unexpectedContent(): never {
  throw Error("The panel host owns its content");
}
const props: Omit<Parameters<typeof ExplorerSidebarDock>[0], "active"> = {
  pane: { id: "explorer", tabIds: [], focusedTabId: null },
  style: { width: 300, flexShrink: 0 },
  uiTabs: [],
  normalizedServerId: "host",
  normalizedWorkspaceId: "workspace",
  isWorkspaceFocused: true,
  closingTabIds: new Set(),
  activeDragTabId: null,
  tabDropPreview: null,
  hoveredCloseTabKey: null,
  onSelectTab: noop,
  onCloseTab: noop,
  onCreateNewTab: noop,
  setHoveredCloseTabKey: noop,
  onCopyResumeCommand: noop,
  onCopyAgentId: noop,
  onCopyTerminalId: noop,
  onCopyFilePath: noop,
  onReloadAgent: noop,
  onRenameTab: noop,
  onCloseTabsToLeft: noop,
  onCloseTabsToRight: noop,
  onCloseOtherTabs: noop,
  onExitFocusMode: noop,
  onReorderTabsInPane: noop,
  buildPaneContentModel: unexpectedContent,
};

function Sidebar({ active }: { active: boolean }) {
  return <ExplorerSidebarDock {...props} active={active} />;
}
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

it("lazily mounts the sidebar, preserves its content through closing, and frees its width", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:900px;height:500px";
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<Sidebar active={false} />));
    expect(host.querySelector('[data-testid="retained-tree"]')).toBe(null);
    expect(lifetime.mounts).toBe(0);
    act(() => root.render(<Sidebar active />));
    const tree = host.querySelector('[data-testid="retained-tree"]');
    const dock = host.querySelector('[data-testid="workspace-explorer-sidebar-retained-host"]');
    if (!(tree instanceof HTMLButtonElement) || !(dock instanceof HTMLElement))
      throw Error("Sidebar did not mount");
    act(() => tree.click());
    expect(tree.textContent).toBe("Expanded folder");
    expect(dock.getBoundingClientRect().width).toBe(300);
    expect(lifetime.mounts).toBe(1);

    act(() => root.render(<Sidebar active={false} />));
    for (let frame = 0; frame < 3; frame++) await nextFrame();
    expect(dock.getBoundingClientRect().width).toBe(0);
    expect(tree.getAttribute("data-active")).toBe("false");
    expect(tree.getAttribute("data-focused")).toBe("false");
    expect(lifetime.cleanups).toBe(0);

    act(() => root.render(<Sidebar active />));
    const firstFrames: string[] = [];
    for (let frame = 0; frame < 3; frame++) {
      await nextFrame();
      firstFrames.push(tree.textContent || "");
    }
    expect(firstFrames).toEqual(["Expanded folder", "Expanded folder", "Expanded folder"]);
    expect(host.querySelector('[data-testid="retained-tree"]')).toBe(tree);
    expect(dock.getBoundingClientRect().width).toBe(300);
    expect(lifetime.mounts).toBe(1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
  expect(lifetime.cleanups).toBe(1);
});
