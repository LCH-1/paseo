import { formatPct, formatResetAt, formatResetDetail } from "./format";
import { displayPercent } from "./model";
import { effectiveUsagePins, type UsageDisplayAs, type UsagePreferences } from "./preferences";
import { windowTone } from "./tone";
import { uniqueUsageReports, usageSourceIdentity } from "./compatibility";
import type { UsageReportEntry, UsageTone, UsageWindow } from "./types";

/** One summary window of one account, as the sidebar Usage item shows it. */
export interface PinnedUsageWindow {
  key: string;
  /** Accessible description, including the source, account, window and percent meaning. */
  label: string;
  /** The window's short name ("5h"), empty for none, or its label when the source sends none. */
  shortLabel: string;
  /** The share shown, under the user's used/remaining preference. */
  percent: number;
  percentText: string;
  tone: UsageTone;
  /** The window's row in the hover card; only the per-provider summary fills it in. */
  detail?: PinnedUsageWindowDetail;
}

/** What the hover card's row for a window reads, column by column. */
export interface PinnedUsageWindowDetail {
  /** "5시간", "주간", "주간 · Fable", or the source's label for any other window. */
  name: string;
  /** The share and what it means under the user's preference: "60% 사용", "40% 남음". */
  percentLabel: string;
  /** "11. 14. (토) 오후 01:00 · 3일 후", or null when the source gives no reset time. */
  reset: string | null;
}

export interface DetailedPinnedUsageWindow extends PinnedUsageWindow {
  detail: PinnedUsageWindowDetail;
}

/** One account's summary windows, under its source's icon. */
export interface PinnedUsageSource {
  key: string;
  icon: string | null;
  windows: PinnedUsageWindow[];
}

/** One account in the hover card: its name, when the source has one, above its windows. */
export interface PinnedUsageAccount {
  key: string;
  label: string | null;
  windows: DetailedPinnedUsageWindow[];
}

/**
 * One provider in the sidebar: every account's windows side by side under one icon, and for the
 * hover card the same windows grouped by account under the provider's name.
 */
export interface PinnedUsageProvider extends PinnedUsageSource {
  label: string;
  windows: DetailedPinnedUsageWindow[];
  accounts: PinnedUsageAccount[];
}

/** How much of each window the one-line summary has room for. */
export type PinnedUsageLayout = "meters" | "labels" | "percents";

// A meter narrower than this is a sliver that reads as noise rather than a share.
export const MIN_METER_WIDTH = 16;
/** The space between a meter and its text. */
export const METER_GAP = 4;

/**
 * The richest layout that fits on one line: every window's meter, else its short label, else its
 * percent alone. Meters are all or none; a line never mixes them. Until the widths are known it
 * shows labels, which never flashes meters that turn out not to fit.
 */
export function choosePinnedUsageLayout(input: {
  available: number | null;
  labelsWidth: number | null;
  percentsWidth: number | null;
  windowCount: number;
}): PinnedUsageLayout {
  const { available, labelsWidth, percentsWidth, windowCount } = input;
  if (available === null || labelsWidth === null || percentsWidth === null) return "labels";
  if (labelsWidth + windowCount * (MIN_METER_WIDTH + METER_GAP) <= available) return "meters";
  if (labelsWidth <= available) return "labels";
  return percentsWidth < labelsWidth ? "percents" : "labels";
}

function describe(entry: UsageReportEntry, windowLabel: string): string {
  const account = entry.account.label ? ` (${entry.account.label})` : "";
  return `${entry.sourceLabel}${account} ${windowLabel}`;
}

/** Reports with every account of a source together, sources in the order they first appear. */
function groupBySource(reports: readonly UsageReportEntry[]): UsageReportEntry[] {
  const sourceIds = [...new Set(reports.map((entry) => entry.sourceId))];
  return sourceIds.flatMap((sourceId) => reports.filter((entry) => entry.sourceId === sourceId));
}

/**
 * The sidebar Usage item's summary: one group per account, grouped by source, each with its
 * windows in its report's order. Accounts with nothing to show are left out.
 */
export function resolvePinnedUsage(
  reports: readonly UsageReportEntry[],
  preferences: UsagePreferences,
): PinnedUsageSource[] {
  const pins = effectiveUsagePins(preferences, reports);
  const meaning = preferences.displayAs === "remaining" ? "left" : "used";
  return groupBySource(uniqueUsageReports(reports)).flatMap((entry) => {
    if (entry.report.status !== "available") return [];
    const windows = entry.report.windows
      .filter(
        (window) =>
          displayPercent(window, preferences.displayAs) !== null &&
          pins.some(
            (pin) =>
              usageSourceIdentity(pin.sourceId) === usageSourceIdentity(entry.sourceId) &&
              pin.windowId === window.id,
          ),
      )
      .map((window) => {
        const percent = displayPercent(window, preferences.displayAs) ?? 0;
        const percentText = formatPct(percent);
        return {
          key: `${entry.id}/${window.id}`,
          label: `${describe(entry, window.label)} ${percentText} ${meaning}`,
          shortLabel: window.shortLabel ?? window.label,
          percent,
          percentText,
          tone: windowTone(window),
        };
      });
    if (windows.length === 0) return [];
    return [{ key: entry.id, icon: entry.icon ?? null, windows }];
  });
}

const SCOPED_WEEKLY_WINDOW = /^weekly_(model|surface)_/;

/**
 * A window's name in the hover card. The windows every Claude and Codex account has are named in
 * Korean, a weekly window scoped to a model or surface keeps its scope ("Weekly · Fable" →
 * "주간 · Fable"), and any other window keeps the source's label.
 */
export function pinnedUsageWindowName(window: Pick<UsageWindow, "id" | "label">): string {
  if (window.id === "five_hour") return "5시간";
  if (window.id === "weekly") return "주간";
  const scope = window.label.indexOf(" · ");
  if (SCOPED_WEEKLY_WINDOW.test(window.id) && scope >= 0) {
    return `주간 · ${window.label.slice(scope + " · ".length)}`;
  }
  return window.label;
}

/** "60% 사용" of the window, or "40% 남음" of it. */
function pinnedUsagePercentLabel(percent: number, displayAs: UsageDisplayAs): string {
  return `${formatPct(percent)} ${displayAs === "remaining" ? "남음" : "사용"}`;
}

function detailPinnedWindow(
  window: PinnedUsageWindow,
  raw: UsageWindow | undefined,
  displayAs: UsageDisplayAs,
  now: number,
): DetailedPinnedUsageWindow {
  const resetAt = formatResetAt(raw?.resetsAt, now);
  return {
    ...window,
    label: resetAt ? `${window.label} · 초기화 ${resetAt}` : window.label,
    detail: {
      name: raw ? pinnedUsageWindowName(raw) : window.shortLabel,
      percentLabel: pinnedUsagePercentLabel(window.percent, displayAs),
      reset: formatResetDetail(raw?.resetsAt, now),
    },
  };
}

/**
 * One provider icon, with every account's own windows and values kept separately. Reset times
 * read relative to `now`.
 */
export function resolveProviderPinnedUsage(
  reports: readonly UsageReportEntry[],
  preferences: UsagePreferences,
  now: number = Date.now(),
): PinnedUsageProvider[] {
  const accounts = resolvePinnedUsage(reports, preferences);
  const sources = new Map<string, PinnedUsageProvider>();
  for (const account of accounts) {
    const entry = reports.find((report) => report.id === account.key);
    if (!entry) continue;
    const provider = usageSourceIdentity(entry.sourceId);
    let source = sources.get(provider);
    if (!source) {
      source = {
        key: provider,
        icon: account.icon,
        label: entry.sourceLabel,
        windows: [],
        accounts: [],
      };
      sources.set(provider, source);
    }
    const windows: DetailedPinnedUsageWindow[] = [];
    for (const window of account.windows) {
      const windowId = window.key.slice(account.key.length + 1);
      const raw =
        entry.report.status === "available"
          ? entry.report.windows.find((candidate) => candidate.id === windowId)
          : undefined;
      windows.push(detailPinnedWindow(window, raw, preferences.displayAs, now));
    }
    source.windows.push(...windows);
    source.accounts.push({ key: account.key, label: entry.account.label ?? null, windows });
  }
  return [...sources.values()];
}
