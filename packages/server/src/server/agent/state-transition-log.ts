import type pino from "pino";
import type { AgentManager, AttentionState, ManagedAgent } from "./agent-manager.js";

type AttentionReason = Extract<AttentionState, { requiresAttention: true }>["attentionReason"];

interface ObservedAgentState {
  lifecycle: ManagedAgent["lifecycle"];
  attention: AttentionReason | null;
}

function observe(agent: ManagedAgent): ObservedAgentState {
  return {
    lifecycle: agent.lifecycle,
    attention: agent.attention.requiresAttention ? agent.attention.attentionReason : null,
  };
}

/**
 * Writes a line whenever an agent changes lifecycle or has its attention flag set or cleared.
 * Without it a wrong status or a stuck unread mark in the app cannot be traced back to what the
 * daemon believed at the time.
 */
export function logAgentStateTransitions(
  agentManager: Pick<AgentManager, "subscribe">,
  logger: pino.Logger,
): () => void {
  const log = logger.child({ module: "agent-state" });
  const observed = new Map<string, ObservedAgentState>();

  return agentManager.subscribe((event) => {
    if (event.type !== "agent_state") {
      return;
    }
    const { agent } = event;
    const next = observe(agent);
    const previous = observed.get(agent.id);
    // A closed agent with nothing unread has no transition left to explain, so it is forgotten.
    if (next.lifecycle === "closed" && next.attention === null) {
      observed.delete(agent.id);
    } else {
      observed.set(agent.id, next);
    }
    if (!previous) {
      return;
    }

    const identity = { agentId: agent.id, provider: agent.provider };
    if (previous.lifecycle !== next.lifecycle) {
      log.info(
        { ...identity, from: previous.lifecycle, to: next.lifecycle },
        "agent_lifecycle_changed",
      );
    }
    if (previous.attention !== next.attention) {
      log.info(
        { ...identity, lifecycle: next.lifecycle, from: previous.attention, to: next.attention },
        "agent_attention_changed",
      );
    }
  });
}
