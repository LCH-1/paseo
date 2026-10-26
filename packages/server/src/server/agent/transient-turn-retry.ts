import type { AgentStreamEvent } from "./agent-sdk-types.js";

export const TURN_RETRY_LIMIT = 3;
export const TURN_RETRY_CONTINUATION =
  "The previous turn was interrupted by a temporary model or connection error. Review the original request and completed actions, then continue only the unfinished work without repeating completed actions.";

const PERMANENT_FAILURE =
  /insufficient[_ ]quota|quota.{0,30}(?:exceeded|exhausted)|(?:spend|usage|budget|credit|billing|weekly|monthly)[_ ]?(?:balance[_ ]?)?(?:limit|exhausted|exceeded)|(?:hit|reached).{0,20}usage limit|authentication|unauthori[sz]ed|invalid[_ ]api[_ ]key|permission denied|context[_ ](?:length|window)|model[_ ]not[_ ]found|invalid[_ ]request|safety|policy violation/i;
const TRANSIENT_CODE =
  /^(?:server_(?:is_)?overloaded|overloaded_error|rate_limit_(?:exceeded|error)|slow_down|request_timeout|connection_failed|server_error|internal_error|econnreset|econnrefused|etimedout|eai_again|429|500|502|503|504)$/i;
const TRANSIENT_MESSAGE =
  /(?:model|server|service).{0,60}(?:at capacity|overload|temporarily unavailable)|\boverloaded\b|\btoo many requests\b|\brate limit(?:ed| exceeded| reached| error)\b|\b(?:network|connection) (?:error|failed|reset|closed|timed out)\b|\brequest (?:timed out|timeout)\b|\bfetch failed\b|\bsocket hang up\b|\b(?:bad gateway|gateway timeout|service unavailable|internal server error)\b|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/i;

export function getTransientTurnRetryDelay(
  event: Extract<AgentStreamEvent, { type: "turn_failed" }>,
  attempts: number,
): number | null {
  if (attempts >= TURN_RETRY_LIMIT) return null;
  const message = [event.error, event.code, event.diagnostic].join("\n");
  if (PERMANENT_FAILURE.test(message)) return null;
  const transient = TRANSIENT_CODE.test(event.code ?? "") || TRANSIENT_MESSAGE.test(message);
  if (!transient) return null;

  const backoffMs = 30_000 * 2 ** attempts;
  const retryAfter = message.match(
    /retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)?\b/i,
  );
  const unit = retryAfter?.[2]?.toLowerCase() ?? "s";
  let unitMs = 1000;
  if (unit === "ms" || unit.startsWith("millisecond")) unitMs = 1;
  else if (unit.startsWith("m")) unitMs = 60_000;
  else if (unit.startsWith("h")) unitMs = 3_600_000;
  const retryAfterMs = retryAfter ? Number(retryAfter[1]) * unitMs : 0;
  const delayMs = Math.max(backoffMs, retryAfterMs);
  // Node clamps overflowing timers to 1ms, which would reverse the provider's delay.
  return delayMs <= 2_147_483_647 ? delayMs : null;
}
