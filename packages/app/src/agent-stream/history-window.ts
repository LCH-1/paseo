import type { StreamItem } from "@/types/stream";

export const DEFAULT_MOUNTED_RECENT_STREAM_ITEMS = 20;

type MountedRecentStreamItemsE2ETestGlobals = typeof globalThis & {
  __PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS?: unknown;
};

function readPositiveIntegerOverride(value: unknown): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value as number);
  return normalized > 0 ? normalized : null;
}

export function getMountedRecentStreamItems(): number {
  const override = readPositiveIntegerOverride(
    (globalThis as MountedRecentStreamItemsE2ETestGlobals)
      .__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS,
  );
  return override ?? DEFAULT_MOUNTED_RECENT_STREAM_ITEMS;
}

// One prompt can start a turn that runs for hours. Local agent histories put the longest
// turns at roughly 280 (p90 of the largest sessions) to 530 tool, message and reasoning rows,
// and a tab kept open while it streams accumulates them all. Web desktop virtualizes the rows
// older than the mounted window, so a long turn keeps 150 to 199 rows mounted and its earlier
// rows mount again as they scroll into view.
export const MAX_MOUNTED_TURN_STREAM_ITEMS = 150;
// The cap moves in steps so a streaming turn does not move the boundary on every new row.
const MOUNTED_TURN_WINDOW_STEP = 50;

export function findMountedWindowStart(input: {
  items: StreamItem[];
  minMountedCount: number;
  /** Bounds a long turn; the window still opens on its user message when that is in reach. */
  maxMountedCount?: number;
}): number {
  const { items, minMountedCount } = input;
  if (items.length <= minMountedCount) {
    return 0;
  }

  const maxMountedCount = Math.max(
    input.maxMountedCount ?? Number.POSITIVE_INFINITY,
    minMountedCount,
  );
  const overflow = items.length - maxMountedCount;
  const floor = overflow > 0 ? overflow - (overflow % MOUNTED_TURN_WINDOW_STEP) : 0;
  let startIndex = Math.max(items.length - minMountedCount, 0);
  while (startIndex > floor && items[startIndex]?.kind !== "user_message") {
    startIndex -= 1;
  }
  return startIndex;
}
