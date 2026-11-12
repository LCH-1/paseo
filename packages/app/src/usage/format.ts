import { formatTokenCount } from "@/components/context-window-meter.utils";
import { clockTimeOptions } from "@/utils/time";
import type { UsageDisplayAs } from "./preferences";
import type { UsageBalanceUnit } from "./types";

export function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function formatPct(value: number): string {
  return `${Math.round(clampPct(value))}%`;
}

/** "31%" of the window used, or "69% left" of it. */
export function formatDisplayPct(value: number, displayAs: UsageDisplayAs): string {
  return displayAs === "used" ? formatPct(value) : `${formatPct(value)} left`;
}

function relativeDuration(iso: string): string | null {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs <= 0) return "now";
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) return `${diffDays}d`;
  if (diffHours > 0) return `${diffHours}h`;
  return `${diffMinutes}m`;
}

export function formatResetLabel(iso: string | null | undefined, retained = false): string | null {
  if (!iso) return null;
  const rel = relativeDuration(iso);
  if (!rel) return null;
  if (rel === "now" && retained) return "Reset time passed";
  return rel === "now" ? "resetting now" : `resets ${rel}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// The sidebar usage card's copy is Korean, so its dates are too.
const RESET_LOCALE = "ko-KR";
const resetFormatters = new Map<boolean, Intl.DateTimeFormat>();

function resetFormatter(withYear: boolean): Intl.DateTimeFormat {
  const cached = resetFormatters.get(withYear);
  if (cached) return cached;
  const options: Intl.DateTimeFormatOptions = {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    ...clockTimeOptions(),
  };
  if (withYear) options.year = "numeric";
  const formatter = new Intl.DateTimeFormat(RESET_LOCALE, options);
  resetFormatters.set(withYear, formatter);
  return formatter;
}

function parseInstant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

/**
 * When a window resets, as a local date and clock time: "11. 14. (토) 오후 01:00", with the year
 * in front when it falls in another year than `now`. Null for a missing or unreadable time.
 */
export function formatResetAt(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  const at = parseInstant(iso);
  if (at === null) return null;
  const date = new Date(at);
  return resetFormatter(date.getFullYear() !== new Date(now).getFullYear()).format(date);
}

/** Local reset date and 24-hour time for a narrow sidebar card. */
export function formatCompactResetAt(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  const at = parseInstant(iso);
  if (at === null) return null;
  const date = new Date(at);
  const year = date.getFullYear() !== new Date(now).getFullYear() ? `${date.getFullYear()}/` : "";
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${year}${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

/** A compact countdown in its largest whole unit; never less than a minute. */
function aheadSpan(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.floor(ms / MINUTE_MS))}m`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  return `D-${Math.floor(ms / DAY_MS)}`;
}

/**
 * How far off a reset is: "D-3", "5h", "12m", or "지남" once it has passed.
 * Null for a missing or unreadable time.
 */
export function formatResetIn(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  const at = parseInstant(iso);
  if (at === null) return null;
  const remainingMs = at - now;
  return remainingMs > 0 ? aheadSpan(remainingMs) : "지남";
}

/** A balance amount as the app's language writes it: "$1,234.50", "12,345". */
export function formatAmount(value: number, unit: UsageBalanceUnit, locale: string): string {
  switch (unit) {
    case "usd":
      return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);
    case "tokens":
      return formatTokenCount(value);
    default:
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  }
}
