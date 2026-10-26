import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSidebarRevealStore } from "@/stores/sidebar-reveal-store";

const INITIAL_VISIBLE_ITEMS = 20;

export function useLimitedSidebarGroup<T extends { workspaceKey: string }>(items: readonly T[]) {
  const [expanded, setExpanded] = useState(false);
  const request = useSidebarRevealStore((state) => state.request);
  const processed = useRef(0);
  useEffect(() => {
    if (!request || processed.current === request.sequence) return;
    const key = `${request.serverId}:${request.workspaceId}`;
    const index = items.findIndex((item) => item.workspaceKey === key);
    if (index < 0) return;
    processed.current = request.sequence;
    if (index >= INITIAL_VISIBLE_ITEMS) setExpanded(true);
  }, [request, items]);
  const visibleItems = useMemo(
    () => (expanded ? items.slice() : items.slice(0, INITIAL_VISIBLE_ITEMS)),
    [expanded, items],
  );
  const canToggle = items.length > INITIAL_VISIBLE_ITEMS;
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  return { visibleItems, expanded, canToggle, toggleExpanded };
}
