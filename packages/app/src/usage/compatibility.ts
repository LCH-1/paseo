import type { UsageReportEntry } from "./types";

// COMPAT(windowsUsageIdentity): old pins and report RPCs retain their source IDs.
export function usageSourceIdentity(sourceId: string): string {
  return sourceId === "claude-windows" ? "claude" : sourceId;
}

/** Keep one card for each account exposed by the shared Claude engine. */
export function uniqueUsageReports(reports: readonly UsageReportEntry[]): UsageReportEntry[] {
  const selected = new Map<string, UsageReportEntry>();
  for (const entry of reports) {
    const key = `${usageSourceIdentity(entry.sourceId)}:${entry.id.slice(entry.sourceId.length + 1)}`;
    const previous = selected.get(key);
    if (
      !previous ||
      (entry.report.status === "available" && previous.report.status !== "available") ||
      (entry.report.status === previous.report.status &&
        entry.sourceId === usageSourceIdentity(entry.sourceId))
    )
      selected.set(key, entry);
  }
  return [...selected.values()];
}
