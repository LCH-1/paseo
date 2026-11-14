import { useRef } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppVisible } from "@/hooks/use-app-visible";

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
  if (live) {
    retainedRef.current = value;
  }
  return live ? value : retainedRef.current;
}
