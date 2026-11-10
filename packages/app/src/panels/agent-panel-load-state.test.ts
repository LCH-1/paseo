import { describe, expect, it } from "vitest";
import type { AgentScreenMissingState } from "@/hooks/use-agent-screen-state-machine";
import {
  clearHistorySyncErrorAfterSuccessfulSync,
  reconcileMissingAgentStateWithPresentAgent,
  resolveTimelineSyncErrorReason,
} from "./agent-panel-load-state";

describe("reconcileMissingAgentStateWithPresentAgent", () => {
  it("clears lookup-only states once the agent record is present", () => {
    expect(reconcileMissingAgentStateWithPresentAgent({ kind: "resolving" })).toEqual({
      kind: "idle",
    });
    expect(
      reconcileMissingAgentStateWithPresentAgent({
        kind: "not_found",
        message: "Agent not found: agent-1",
      }),
    ).toEqual({ kind: "idle" });
  });

  it("preserves history sync errors while the agent record is present", () => {
    const state: AgentScreenMissingState = {
      kind: "error",
      message: "Failed to get logs: session is archived",
    };

    expect(reconcileMissingAgentStateWithPresentAgent(state)).toBe(state);
  });
});

describe("clearHistorySyncErrorAfterSuccessfulSync", () => {
  it("clears a sync error after a later successful refresh", () => {
    expect(
      clearHistorySyncErrorAfterSuccessfulSync({
        kind: "error",
        message: "Failed to get logs: session is archived",
      }),
    ).toEqual({ kind: "idle" });
  });

  it("leaves non-error states alone", () => {
    const state: AgentScreenMissingState = { kind: "resolving" };

    expect(clearHistorySyncErrorAfterSuccessfulSync(state)).toBe(state);
  });
});

describe("resolveTimelineSyncErrorReason", () => {
  it("shows the refusal a plugin wrote for the user without the daemon's hook wrapper", () => {
    expect(
      resolveTimelineSyncErrorReason({
        missingAgentState: { kind: "idle" },
        timelineError:
          "Plugin aster before agent.session_open failed: Aster: 모든 Claude 계정의 사용 한도가 소진되었습니다. 가장 빠른 초기화는 오후 03:00입니다.",
      }),
    ).toBe(
      "Aster: 모든 Claude 계정의 사용 한도가 소진되었습니다. 가장 빠른 초기화는 오후 03:00입니다.",
    );
  });

  it("shows any other daemon failure as it was reported", () => {
    expect(
      resolveTimelineSyncErrorReason({
        missingAgentState: { kind: "idle" },
        timelineError: "Agent agent-1 already has an active writer",
      }),
    ).toBe("Agent agent-1 already has an active writer");
  });

  it("prefers the agent lookup failure that put the panel in its error state", () => {
    expect(
      resolveTimelineSyncErrorReason({
        missingAgentState: { kind: "error", message: "Timeout waiting for message (15000ms)" },
        timelineError: null,
      }),
    ).toBe("Timeout waiting for message (15000ms)");
  });

  it("has no reason when nothing was reported", () => {
    expect(
      resolveTimelineSyncErrorReason({ missingAgentState: { kind: "idle" }, timelineError: null }),
    ).toBeNull();
    expect(
      resolveTimelineSyncErrorReason({ missingAgentState: { kind: "idle" }, timelineError: "  " }),
    ).toBeNull();
  });
});
