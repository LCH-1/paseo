import { expect, test } from "vitest";
import { getTransientTurnRetryDelay } from "./transient-turn-retry.js";

test.each([
  "Selected model is at capacity. Please try a different model.",
  "The model is temporarily overloaded.",
  "Network error",
  "Connection reset by peer",
  "Request timed out",
  "Service unavailable",
  "Too many requests",
])("retries temporary provider failures: %s", (error) => {
  const event = { type: "turn_failed", provider: "codex", error } as const;
  expect([0, 1, 2, 3].map((attempt) => getTransientTurnRetryDelay(event, attempt))).toEqual([
    30_000,
    60_000,
    120_000,
    null,
  ]);
});

test.each([
  "server_overloaded",
  "server_is_overloaded",
  "overloaded_error",
  "rate_limit_exceeded",
  "request_timeout",
  "ECONNRESET",
  "503",
])("uses structured transient error codes: %s", (code) => {
  expect(
    getTransientTurnRetryDelay(
      { type: "turn_failed", provider: "claude", error: "Failed", code },
      0,
    ),
  ).toBe(30_000);
});

test.each([
  "invalid model id",
  "Authentication failed: service unavailable",
  "insufficient_quota",
  "quota exceeded: too many requests",
  "usage_limit_exceeded",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "context_length_exceeded",
  "Permission denied",
  "Tool execution failed",
  "You've hit your usage limit. Please try again later.",
])("does not retry permanent or unclassified failures: %s", (error) => {
  expect(
    getTransientTurnRetryDelay({ type: "turn_failed", provider: "codex", error }, 0),
  ).toBeNull();
});

test("honors a longer retry-after without overflowing Node timers", () => {
  const event = {
    type: "turn_failed",
    provider: "codex",
    error: "Overloaded. Retry-After: 180",
  } as const;
  expect(getTransientTurnRetryDelay(event, 0)).toBe(180_000);
  expect(
    getTransientTurnRetryDelay({ ...event, error: "Overloaded. Retry-After: 999999999999" }, 0),
  ).toBeNull();
});

test.each([
  ["Retry after 3 minutes", 180_000],
  ["Retry-After: 360000 milliseconds", 360_000],
  ["Retry after 1 hour", 3_600_000],
  ["Retry after 2 seconds", 30_000],
])("honors provider wait units: %s", (hint, delay) => {
  expect(
    getTransientTurnRetryDelay(
      { type: "turn_failed", provider: "codex", error: `Overloaded. ${hint}` },
      0,
    ),
  ).toBe(delay);
});
