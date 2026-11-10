export interface RepeatSummary<Fields> {
  fields: Fields;
  count: number;
  p50Ms: number;
  maxMs: number;
}

interface TrackedKind<Fields> {
  fields: Fields;
  durationsMs: number[];
  firstReportedByCaller: boolean;
  quietWindows: number;
}

// Kind keys can carry client-chosen strings, so the table must not grow without bound.
const MAX_TRACKED_KINDS = 256;
// A kind that polls slower than the window (every 66s, every 2 minutes) must stay collapsed.
const QUIET_WINDOWS_BEFORE_FORGET = 5;

/**
 * Collapses an event that keeps recurring into one summary per window. The caller reports the
 * first occurrence of a kind itself; while the kind keeps recurring only the summary is reported.
 */
export class RepeatDigest<Fields> {
  private readonly tracked = new Map<string, TrackedKind<Fields>>();

  /** Returns true when the caller should report this occurrence itself. */
  record(kind: string, fields: Fields, durationMs: number): boolean {
    const known = this.tracked.get(kind);
    if (known) {
      known.durationsMs.push(durationMs);
      return false;
    }
    if (this.tracked.size < MAX_TRACKED_KINDS) {
      this.tracked.set(kind, {
        fields,
        durationsMs: [durationMs],
        firstReportedByCaller: true,
        quietWindows: 0,
      });
    }
    return true;
  }

  /** Closes the window and returns a summary for every kind with occurrences nobody reported. */
  flush(): RepeatSummary<Fields>[] {
    const summaries: RepeatSummary<Fields>[] = [];
    for (const [kind, entry] of this.tracked) {
      if (entry.durationsMs.length === 0) {
        entry.quietWindows += 1;
        if (entry.quietWindows >= QUIET_WINDOWS_BEFORE_FORGET) this.tracked.delete(kind);
        continue;
      }
      const unreported = entry.durationsMs.length - (entry.firstReportedByCaller ? 1 : 0);
      if (unreported > 0) summaries.push(summarize(entry));
      entry.durationsMs = [];
      entry.firstReportedByCaller = false;
      entry.quietWindows = 0;
    }
    return summaries;
  }
}

function summarize<Fields>(entry: TrackedKind<Fields>): RepeatSummary<Fields> {
  const sorted = [...entry.durationsMs].sort((a, b) => a - b);
  return {
    fields: entry.fields,
    count: sorted.length,
    p50Ms: Math.round(sorted[Math.floor(sorted.length / 2)]),
    maxMs: Math.round(sorted[sorted.length - 1]),
  };
}
