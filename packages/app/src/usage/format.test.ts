import { describe, expect, it } from "vitest";
import { formatAmount, formatResetAt, formatResetIn, formatResetLabel } from "./format";

describe("formatAmount", () => {
  it("groups thousands in the app's language", () => {
    expect(formatAmount(12345, "credits", "en")).toBe("12,345");
    expect(formatAmount(12345, "requests", "en")).toBe("12,345");
    expect(formatAmount(12345, "credits", "fr").replace(/\s/g, " ")).toBe("12 345");
  });

  it("formats dollars as the language writes currency", () => {
    expect(formatAmount(1234.5, "usd", "en")).toBe("$1,234.50");
    expect(formatAmount(1234.5, "usd", "fr").replace(/\s/g, " ")).toBe("1 234,50 $US");
  });
});

it("retained reset times that have passed do not claim the quota is resetting", () => {
  const past = "2000-01-01T00:00:00.000Z";
  expect(formatResetLabel(past, true)).toBe("Reset time passed");
  expect(formatResetLabel(past)).toBe("resetting now");
  expect(formatResetLabel(null, true)).toBeNull();
});

// Clock times follow the machine's 12/24-hour preference, so each expectation names both.
const twelveHour = ["h11", "h12"].includes(
  new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle ?? "",
);
function clock(twelve: string, twentyFour: string): string {
  return twelveHour ? twelve : twentyFour;
}

/** A local wall-clock time, as the ISO instant a source sends it. */
function local(year: number, month: number, day: number, hour: number, minute: number, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second).toISOString();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = new Date(2026, 10, 11, 11, 0).getTime();

describe("formatResetAt", () => {
  it("writes the hour in two digits and never the seconds", () => {
    expect(formatResetAt(local(2026, 11, 14, 13, 0), now)).toBe(
      `11. 14. (토) ${clock("오후 01:00", "13:00")}`,
    );
    expect(formatResetAt(local(2026, 11, 17, 3, 0), now)).toBe(
      `11. 17. (화) ${clock("오전 03:00", "03:00")}`,
    );
    expect(formatResetAt(local(2026, 11, 15, 10, 36, 39), now)).toBe(
      `11. 15. (일) ${clock("오전 10:36", "10:36")}`,
    );
  });

  it("puts the year in front only when the reset falls in another year", () => {
    expect(formatResetAt(local(2027, 1, 2, 9, 5), now)).toBe(
      `2027. 1. 2. (토) ${clock("오전 09:05", "09:05")}`,
    );
    expect(formatResetAt(local(2025, 12, 31, 23, 0), now)).toMatch(/^2025\. 12\. 31\. /);
    expect(formatResetAt(local(2026, 12, 31, 23, 0), now)).toMatch(/^12\. 31\. /);
  });

  it("has nothing to say about a missing or unreadable time", () => {
    for (const value of [null, undefined, "", "not a date"]) {
      expect(formatResetAt(value, now)).toBeNull();
      expect(formatResetIn(value, now)).toBeNull();
    }
  });
});

describe("formatResetIn", () => {
  const ahead = (ms: number) => new Date(now + ms).toISOString();

  it.each([
    [30_000, "1분 후 초기화"],
    [59 * MINUTE, "59분 후 초기화"],
    [HOUR - 1000, "59분 후 초기화"],
    [HOUR, "1시간 후 초기화"],
    [23 * HOUR, "23시간 후 초기화"],
    [DAY - MINUTE, "23시간 후 초기화"],
    [DAY, "1일 후 초기화"],
    [3 * DAY + 2 * HOUR, "3일 후 초기화"],
  ])("reads %i ms ahead as %s, in its largest whole unit", (ms, expected) => {
    expect(formatResetIn(ahead(ms), now)).toBe(expected);
  });

  it("says a reset time that has come has passed", () => {
    expect(formatResetIn(ahead(0), now)).toBe("초기화 시각 지남");
    expect(formatResetIn(ahead(-5 * MINUTE), now)).toBe("초기화 시각 지남");
  });
});
