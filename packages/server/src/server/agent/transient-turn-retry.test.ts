import { expect, test } from "vitest";
import { getTransientTurnRetryDelay, isAccountLimitError } from "./transient-turn-retry.js";

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

test.each([
  "API error: 429 This request would exceed your account's rate limit. Please try again later · model not changed",
  "rate_limit_error",
  "Too many requests",
  "You've hit your usage limit. Please try again later.",
  "You've hit your limit · resets 3pm",
  "You've reached your Fable limit · resets Nov 17, 3pm",
  "You've reached your Opus 4.1 limit",
  "Claude AI usage limit reached|1763359200",
  "Weekly limit reached",
  "You've hit your weekly limit · resets Nov 17, 3pm",
  "You've hit your session limit · resets 3pm",
  "5-hour limit reached ∙ resets 3pm",
  "You've reached your model limit",
  "Number of request tokens has exceeded your per-minute rate limit",
  "This request would exceed the rate limit for your organization of 8,000 output tokens per minute",
  "usage_limit_reached",
  "insufficient_quota",
])("recognises an account limit another account could avoid: %s", (message) => {
  expect(isAccountLimitError(new Error(message))).toBe(true);
});

test("recognises an account limit from structured status and code fields", () => {
  expect(isAccountLimitError(Object.assign(new Error("Request failed"), { status: 429 }))).toBe(
    true,
  );
  expect(isAccountLimitError(Object.assign(new Error("Request failed"), { code: "429" }))).toBe(
    true,
  );
  expect(
    isAccountLimitError(new Error("Model change failed", { cause: new Error("rate_limit_error") })),
  ).toBe(true);
});

test.each([
  "Model not found: claude-fable-5-2",
  "Selected model is at capacity. Please try a different model.",
  "Network error",
  "Unexpected token at position 429",
  "context_length_exceeded",
  "You've reached the context window limit",
  "You've reached the token limit for this conversation",
  "Reached the token limit",
  "You've reached your token limit",
  "You've hit the context limit",
  "You've reached your context limit",
  "You've hit your max output tokens limit",
  "You've reached your budget limit",
  "Reached the maximum budget limit for this session",
  "Reached the tool call limit for this turn",
  "You've hit the image size limit",
  "Authentication failed: rate limit check unavailable",
  "Permission denied",
])("leaves failures another account would not fix alone: %s", (message) => {
  expect(isAccountLimitError(new Error(message))).toBe(false);
});
