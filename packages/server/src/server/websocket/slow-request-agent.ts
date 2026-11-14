import type { WSInboundMessage } from "../messages.js";

type SessionRequest = Extract<WSInboundMessage, { type: "session" }>["message"];

/** An agent the daemon knows, live or stored. */
export interface KnownAgentRecord {
  id: string;
  provider: string;
}

export interface KnownAgentLookup {
  /** The live or stored agent with exactly this id. */
  get(id: string): Promise<KnownAgentRecord | null>;
  /** Every live and stored agent, for an identifier given as an id prefix. */
  list(): Promise<KnownAgentRecord[]>;
}

/** The agent a slow request was aimed at, as its log line names it. */
export interface SlowRequestAgent {
  agentId?: string;
  provider?: string;
}

// Provider ids are client-chosen strings on draft requests; anything else is left out of the log.
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Names the agent behind a slow request so its latency can be tied to a provider and a session.
 * The request's identifier may be an agent title, which is user text: only an id the daemon
 * resolved from its own records is ever returned, never the identifier as sent.
 */
export async function describeSlowRequestAgent(
  request: SessionRequest,
  agents: KnownAgentLookup,
): Promise<SlowRequestAgent> {
  const identifier = "agentId" in request ? request.agentId : undefined;
  if (typeof identifier === "string" && identifier.trim()) {
    const agent = await resolveKnownAgent(identifier.trim(), agents).catch(() => null);
    if (agent) return { agentId: agent.id, provider: agent.provider };
  }
  const provider = requestedProvider(request);
  return provider !== undefined && PROVIDER_ID_PATTERN.test(provider) ? { provider } : {};
}

async function resolveKnownAgent(
  identifier: string,
  agents: KnownAgentLookup,
): Promise<KnownAgentRecord | null> {
  const exact = await agents.get(identifier);
  if (exact) return exact;
  const ids = new Map<string, KnownAgentRecord>();
  for (const agent of await agents.list()) {
    if (agent.id.startsWith(identifier)) ids.set(agent.id, agent);
  }
  return ids.size === 1 ? ([...ids.values()][0] ?? null) : null;
}

/** The provider a request names for an agent it creates, drafts, resumes, or asks about. */
function requestedProvider(request: SessionRequest): string | undefined {
  switch (request.type) {
    case "create_agent_request":
    case "agent.create.request":
      return request.config.provider;
    case "workspace.create.request":
      return request.agent?.config.provider;
    case "list_provider_features_request":
      return request.draftConfig.provider;
    case "resume_agent_request":
      return request.handle?.provider;
    default:
      return "provider" in request && typeof request.provider === "string"
        ? request.provider
        : undefined;
  }
}
