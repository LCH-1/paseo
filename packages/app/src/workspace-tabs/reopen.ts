import {
  findPaneById,
  FOCUSED_PANE_PLACEMENT,
  useWorkspaceLayoutStore,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";
import { createWorkspaceBrowser } from "@/desktop/browser/store";

interface ReopenClosedTabInput {
  workspaceKey: string;
  createTerminal: (input: { paneId?: string }) => void;
}

export function reopenLastClosedWorkspaceTab(input: ReopenClosedTabInput): string | null {
  const store = useWorkspaceLayoutStore.getState();
  const closed = store.takeLastClosedTab(input.workspaceKey);
  if (!closed) return null;
  const layout = store.layoutByWorkspace[input.workspaceKey];
  const pane = closed.paneId && layout ? findPaneById(layout.root, closed.paneId) : null;
  const placement: WorkspaceTabPlacement = pane
    ? { mode: "pane", paneId: pane.id }
    : FOCUSED_PANE_PLACEMENT;
  if (closed.tab.target.kind === "terminal") {
    // Closing a terminal kills its process; restoring its old id cannot revive it.
    input.createTerminal(pane ? { paneId: pane.id } : {});
    return null;
  }
  let target = closed.tab.target;
  if (target.kind === "browser") {
    const { browserId } = createWorkspaceBrowser({ initialUrl: closed.browserUrl ?? undefined });
    target = { kind: "browser", browserId };
  }
  const tabId = store.openTab({
    workspaceKey: input.workspaceKey,
    target,
    intent: "reveal",
    pin: true,
    placement,
  });
  if (tabId && closed.tab.state !== undefined) {
    store.setTabState(input.workspaceKey, tabId, closed.tab.state);
  }
  return tabId;
}
