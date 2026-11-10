import pino from "pino";
import { describe, expect, it } from "vitest";
import { createStub } from "../test-utils/class-mocks.js";
import type { AgentSubscriber, AttentionState, ManagedAgent } from "./agent-manager.js";
import { logAgentStateTransitions } from "./state-transition-log.js";

interface TransitionLine {
  msg: string;
  [field: string]: unknown;
}

const READ: AttentionState = { requiresAttention: false };
const FINISHED: AttentionState = {
  requiresAttention: true,
  attentionReason: "finished",
  attentionTimestamp: new Date("2026-11-10T06:00:00.000Z"),
};

function createObservedAgentManager() {
  const subscribers = new Set<AgentSubscriber>();
  const lines: TransitionLine[] = [];
  const logger = pino(
    { level: "info", base: null, timestamp: false },
    {
      write(line: string) {
        lines.push(JSON.parse(line));
      },
    },
  );
  const stop = logAgentStateTransitions(
    {
      subscribe(callback) {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
      },
    },
    logger,
  );
  return {
    lines,
    stop,
    report(lifecycle: ManagedAgent["lifecycle"], attention: AttentionState, agentId = "agent-1") {
      const agent = createStub<ManagedAgent>({
        id: agentId,
        provider: "claude",
        lifecycle,
        attention,
      });
      for (const subscriber of subscribers) subscriber({ type: "agent_state", agent });
    },
  };
}

describe("logAgentStateTransitions", () => {
  it("writes a line for each lifecycle change and none while the lifecycle holds", () => {
    const manager = createObservedAgentManager();

    manager.report("idle", READ);
    manager.report("running", READ);
    manager.report("running", READ);
    manager.report("idle", READ);

    expect(manager.lines).toEqual([
      {
        level: 30,
        module: "agent-state",
        agentId: "agent-1",
        provider: "claude",
        from: "idle",
        to: "running",
        msg: "agent_lifecycle_changed",
      },
      {
        level: 30,
        module: "agent-state",
        agentId: "agent-1",
        provider: "claude",
        from: "running",
        to: "idle",
        msg: "agent_lifecycle_changed",
      },
    ]);
  });

  it("writes a line when attention is set and when it is cleared", () => {
    const manager = createObservedAgentManager();

    manager.report("running", READ);
    manager.report("idle", FINISHED);
    manager.report("idle", READ);

    expect(manager.lines.filter((line) => line.msg === "agent_attention_changed")).toEqual([
      expect.objectContaining({
        agentId: "agent-1",
        lifecycle: "idle",
        from: null,
        to: "finished",
      }),
      expect.objectContaining({
        agentId: "agent-1",
        lifecycle: "idle",
        from: "finished",
        to: null,
      }),
    ]);
  });

  it("still reports the cleared attention of an agent that closed while unread", () => {
    const manager = createObservedAgentManager();

    manager.report("idle", FINISHED);
    manager.report("closed", FINISHED);
    manager.report("closed", READ);

    expect(manager.lines.map((line) => line.msg)).toEqual([
      "agent_lifecycle_changed",
      "agent_attention_changed",
    ]);
    expect(manager.lines[1]).toMatchObject({ lifecycle: "closed", from: "finished", to: null });
  });

  it("takes the first sighting of an agent as its starting point", () => {
    const manager = createObservedAgentManager();

    manager.report("idle", FINISHED, "agent-1");
    manager.report("running", READ, "agent-2");

    expect(manager.lines).toEqual([]);
  });

  it("stops writing once detached", () => {
    const manager = createObservedAgentManager();
    manager.report("idle", READ);

    manager.stop();
    manager.report("running", READ);

    expect(manager.lines).toEqual([]);
  });
});
