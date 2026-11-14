import { useEffect, useMemo, useRef, useState } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useSessionStore } from "@/stores/session-store";

/**
 * A stream that is not shown keeps at most this many rows in memory once its reader was at
 * the live edge. Local agent histories put the longest single turns near 530 rows, so this
 * holds the latest turn whole in nearly every case.
 */
export const MAX_HIDDEN_STREAM_ITEMS = 1_000;

/**
 * Whether the stream should recompute what it shows. An inactive tab slot and a hidden
 * window (minimized, fully covered, screen locked, background browser tab) paint nothing,
 * so reprojecting the timeline and reconciling rows for them only burns CPU. The session
 * store keeps receiving the stream either way; the view catches up in one render when it
 * is shown again.
 */
export function useStreamPresentationLive(): boolean {
  const panelActive = useRetainedPanelActive();
  const appVisible = useAppVisible();
  return panelActive && appVisible;
}

/**
 * Holds the last value seen while live; returns the current value again once live. A change
 * of `refreshKey` takes the current value once while not live, so a hold can be dropped.
 */
export function useRetainedValue<T>(value: T, live: boolean, refreshKey?: unknown): T {
  const retainedRef = useRef(value);
  const refreshKeyRef = useRef(refreshKey);
  if (live || refreshKeyRef.current !== refreshKey) {
    retainedRef.current = value;
    refreshKeyRef.current = refreshKey;
  }
  return retainedRef.current;
}

/**
 * While the stream is not shown and its reader was at the live edge, replaces a timeline
 * longer than MAX_HIDDEN_STREAM_ITEMS with the daemon's latest page; older rows load again
 * when scrolled to. Returns a counter that changes after each completed release, so a view
 * frozen while hidden can let go of the rows it held.
 */
export function useReleaseHiddenStreamHistory(input: {
  live: boolean;
  atLiveEdge: boolean;
  itemCount: number;
  release: (() => Promise<void>) | null;
}): number {
  const { live, atLiveEdge, itemCount, release } = input;
  const [releases, setReleases] = useState(0);
  const inFlightRef = useRef(false);
  const shouldRelease =
    !live && atLiveEdge && release !== null && itemCount > MAX_HIDDEN_STREAM_ITEMS;

  useEffect(() => {
    if (!shouldRelease || !release || inFlightRef.current) return;
    inFlightRef.current = true;
    let current = true;
    const run = async () => {
      try {
        await release();
        if (current) setReleases((count) => count + 1);
      } catch {
        // The rows stay; a later hide or growth past the limit tries again.
      } finally {
        inFlightRef.current = false;
      }
    };
    void run();
    return () => {
      current = false;
    };
  }, [release, shouldRelease]);

  return releases;
}

/**
 * The stream view's release of hidden history, for a chat whose rows come from the session
 * store. A view fed its own rows (a sub-agent pager, a draft, a read-only transcript) keeps
 * them.
 */
export function useReleaseHiddenSessionStreamHistory(input: {
  serverId: string;
  agentId: string;
  live: boolean;
  isNearBottom: boolean;
  isTimelineDetached: boolean;
  itemCount: number;
  ownSource: { historyPagination?: unknown; readOnly: boolean; streamHead?: unknown };
}): number {
  const { serverId, agentId, ownSource } = input;
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  const usesSessionTimeline =
    !ownSource.historyPagination && !ownSource.readOnly && !ownSource.streamHead;
  const release = useMemo(
    () =>
      usesSessionTimeline && viewedTimelineSync
        ? () => viewedTimelineSync.releaseRetainedHistory(agentId)
        : null,
    [agentId, usesSessionTimeline, viewedTimelineSync],
  );
  return useReleaseHiddenStreamHistory({
    live: input.live,
    atLiveEdge: input.isNearBottom && !input.isTimelineDetached,
    itemCount: input.itemCount,
    release,
  });
}
