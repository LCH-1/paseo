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

/**
 * How far off a reset is, in its largest whole unit: "3일 후", "5시간 후", "12분 후" (never less
 * than a minute), or "초기화 시각 지남" once it has passed. Null for a missing or unreadable time.
 */
export function formatResetIn(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  const at = parseInstant(iso);
  if (at === null) return null;
  const remainingMs = at - now;
  if (remainingMs <= 0) return "초기화 시각 지남";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.floor(remainingMs / MINUTE_MS))}분 후`;
  if (remainingMs < DAY_MS) return `${Math.floor(remainingMs / HOUR_MS)}시간 후`;
  return `${Math.floor(remainingMs / DAY_MS)}일 후`;
}

/** Both at once, the way the sidebar usage card shows them: "11. 14. (토) 오후 01:00 · 3일 후". */
export function formatResetDetail(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  const at = formatResetAt(iso, now);
  const remaining = formatResetIn(iso, now);
  return at && remaining ? `${at} · ${remaining}` : null;
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
