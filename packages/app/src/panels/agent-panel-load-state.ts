import type { AgentScreenMissingState } from "@/hooks/use-agent-screen-state-machine";

export function reconcileMissingAgentStateWithPresentAgent(
  state: AgentScreenMissingState,
): AgentScreenMissingState {
  if (state.kind === "resolving" || state.kind === "not_found") {
    return { kind: "idle" };
  }
  return state;
}

export function clearHistorySyncErrorAfterSuccessfulSync(
  state: AgentScreenMissingState,
): AgentScreenMissingState {
  if (state.kind === "error") {
    return { kind: "idle" };
  }
  return state;
}

// The daemon wraps a plugin's refusal this way (server/plugins/runtime.ts). What follows the
// wrapper is the plugin's own sentence for the user, such as a quota notice with its reset time.
const PLUGIN_REFUSAL_WRAPPER = /^Plugin \S+ before \S+ failed: /;

/** Why the sync-error banner is showing, or null when the daemon gave no reason. */
export function resolveTimelineSyncErrorReason(input: {
  missingAgentState: AgentScreenMissingState;
  timelineError: string | null;
}): string | null {
  const reported =
    input.missingAgentState.kind === "error"
      ? input.missingAgentState.message
      : input.timelineError;
  if (!reported) return null;
  const reason = reported.replace(PLUGIN_REFUSAL_WRAPPER, "").trim();
  return reason.length > 0 ? reason : null;
}
