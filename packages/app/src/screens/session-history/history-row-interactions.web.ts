export interface HistoryAgentTarget {
  serverId: string;
  workspaceId: string;
  agentId: string;
}

export function attachHistoryRowInteractions(
  node: HTMLElement,
  onOpen: (target: HistoryAgentTarget) => void,
) {
  function historyRow(event: MouseEvent) {
    return event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-history-agent-id]")
      : null;
  }
  function openBackground(event: MouseEvent) {
    if (
      event.type === "click"
        ? event.button !== 0 || !(event.ctrlKey || event.metaKey)
        : event.button !== 1
    )
      return;
    const row = historyRow(event);
    if (!row || !node.contains(row)) return;
    event.preventDefault();
    event.stopPropagation();
    const {
      historyServerId: serverId,
      historyWorkspaceId: workspaceId,
      historyAgentId: agentId,
    } = row.dataset;
    if (!serverId || !workspaceId || !agentId) return;
    onOpen({ serverId, workspaceId, agentId });
  }
  function preventAutoscroll(event: MouseEvent) {
    if (event.button === 1 && historyRow(event)) event.preventDefault();
  }
  node.addEventListener("click", openBackground, true);
  node.addEventListener("auxclick", openBackground, true);
  node.addEventListener("mousedown", preventAutoscroll, true);
  return () => {
    node.removeEventListener("click", openBackground, true);
    node.removeEventListener("auxclick", openBackground, true);
    node.removeEventListener("mousedown", preventAutoscroll, true);
  };
}
