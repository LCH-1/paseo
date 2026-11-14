import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useSessionStore } from "@/stores/session-store";

/**
 * A stream that is not shown and holds more rows than this lets them go once its reader was
 * at the live edge and it stayed out of view for HIDDEN_HISTORY_RELEASE_DELAY_MS. This is only
 * the threshold: what remains is the daemon's latest page (TIMELINE_FETCH_PAGE_SIZE rows), so
 * a latest turn longer than that page loses its prompt from memory until it is scrolled back
 * to. Its footer duration and copy then cover the loaded rows only, as in a freshly opened chat.
 */
export const MAX_HIDDEN_STREAM_ITEMS = 1_000;

/**
 * How long a stream stays out of view before it lets its rows go. Switching to another tab
 * and back, or covering the window for a moment, keeps every row; a window left minimized,
 * locked or behind another tab for longer frees them.
 */
export const HIDDEN_HISTORY_RELEASE_DELAY_MS = 5 * 60_000;

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

/** Holds the last value seen while live; returns the current value again once live. */
export function useRetainedValue<T>(value: T, live: boolean): T {
  const retainedRef = useRef(value);
  if (live) retainedRef.current = value;
  return retainedRef.current;
}

function countRelease(count: number): number {
  return count + 1;
}

/** The rows of one chat as a stream view can keep or let go of them. */
export interface ReleasableStreamHistory {
  /**
   * Marks the rows as read by a view on screen until the returned function runs. A release
   * still waiting for its page then leaves the rows whole.
   */
  retain(): () => void;
  /**
   * Replaces the rows with the daemon's latest page. Settles after that page was applied, to
   * whether it replaced them.
   */
  release(): Promise<boolean>;
}

/**
 * While the stream is not shown and its reader was at the live edge, replaces a timeline
 * longer than MAX_HIDDEN_STREAM_ITEMS with the daemon's latest page once it stayed out of view
 * for HIDDEN_HISTORY_RELEASE_DELAY_MS; older rows load again when scrolled to. Returns a counter
 * that changes after each release that replaced the rows while the stream was still not shown,
 * so the view can mount again and let go of every row it held.
 */
export function useReleaseHiddenStreamHistory(input: {
  live: boolean;
  atLiveEdge: boolean;
  itemCount: number;
  history: ReleasableStreamHistory | null;
}): number {
  const { live, atLiveEdge, itemCount, history } = input;
  const [releases, setReleases] = useState(0);
  const mountedRef = useRef(false);
  const liveRef = useRef(live);
  const inFlightRef = useRef(false);
  const shouldRelease =
    !live && atLiveEdge && history !== null && itemCount > MAX_HIDDEN_STREAM_ITEMS;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A view on screen may be read, so a release already on its way must leave its rows. Both
  // run in the commit that shows the view, before a page still on its way can be applied.
  useLayoutEffect(() => {
    liveRef.current = live;
  }, [live]);
  useLayoutEffect(() => {
    if (!live || !history) return;
    return history.retain();
  }, [history, live]);

  useEffect(() => {
    if (!shouldRelease || !history) return;
    const releaseHeldRows = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const replaced = await history.release();
        // The applied page re-renders this view before the release settles, which already
        // ends this effect. The counter still has to move, or a frozen view keeps the old rows.
        // A view shown again meanwhile kept its rows, or shows the page already, and stays.
        if (replaced && mountedRef.current && !liveRef.current) setReleases(countRelease);
      } catch {
        // The rows stay; a later hide or growth past the limit tries again.
      } finally {
        inFlightRef.current = false;
      }
    };
    const timer = setTimeout(() => void releaseHeldRows(), HIDDEN_HISTORY_RELEASE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [history, shouldRelease]);

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
  const history = useMemo<ReleasableStreamHistory | null>(
    () =>
      usesSessionTimeline && viewedTimelineSync
        ? {
            retain: () => viewedTimelineSync.retainHistory(agentId),
            release: () => viewedTimelineSync.releaseRetainedHistory(agentId),
          }
        : null,
    [agentId, usesSessionTimeline, viewedTimelineSync],
  );
  return useReleaseHiddenStreamHistory({
    live: input.live,
    atLiveEdge: input.isNearBottom && !input.isTimelineDetached,
    itemCount: input.itemCount,
    history,
  });
}
