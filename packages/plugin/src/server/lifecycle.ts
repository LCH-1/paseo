import type { AgentToolDefinition } from "./agent-tools.js";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
  AgentSessionConfig,
} from "@getpaseo/protocol/agent-types";
import type { PaseoApi } from "@getpaseo/client";
import type { WorkspaceCreateRequest } from "@getpaseo/protocol/messages";

export interface PluginHookContext {
  paseo: PaseoApi;
  signal: AbortSignal;
}

export interface PluginHookWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
}

export interface PluginHookAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
}

export interface PluginSessionOpenRequest {
  agentId: string;
  workspaceId: string | null;
  provider: string;
  cwd: string;
  reason: "create" | "resume" | "refresh" | "import";
  purpose: "interactive" | "history";
  readonly title: string | null;
  readonly labels: Readonly<Record<string, string>>;
  tools: AgentToolDefinition[];
  env: Record<string, string>;
  mcpServers: NonNullable<AgentSessionConfig["mcpServers"]>;
}

export type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };

export interface PluginHookEvents {
  "agent.turn.started": { agent: PluginHookAgent; turnId: string | null };
  "agent.turn.completed": {
    agent: PluginHookAgent;
    turnId: string | null;
    outcome: PluginTurnOutcome;
    /**
     * @deprecated Always empty. Fetch history on demand with
     * context.paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 20 }).
     */
    timeline: readonly AgentTimelineItem[];
  };
  "agent.permission.started": { agent: PluginHookAgent; request: AgentPermissionRequest };
  "agent.permission.completed": {
    agent: PluginHookAgent;
    requestId: string;
    resolution: AgentPermissionResponse;
  };
  "agent.archive.completed": { agent: PluginHookAgent; archivedAt: string };
  "agent.create.completed": { agent: PluginHookAgent };
  "agent.close.completed": { agent: PluginHookAgent };
  "workspace.create.completed": { workspace: PluginHookWorkspace };
  "workspace.archive.completed": { workspace: PluginHookWorkspace };
}

export interface PluginHookRequests {
  "agent.create.prepare": { config: AgentSessionConfig; env?: Record<string, string> };
  "agent.open.prepare": PluginSessionOpenRequest;
  "workspace.create.prepare": Omit<WorkspaceCreateRequest, "type" | "requestId">;
}

export type PluginHooks = {
  [Name in keyof PluginHookRequests]: {
    request: PluginHookRequests[Name];
    result: PluginHookRequests[Name];
  };
} & { [Name in keyof PluginHookEvents]: { payload: PluginHookEvents[Name] } };

export type PluginHookPayload<Name extends keyof PluginHooks> = {
  [Key in keyof PluginHooks]: PluginHooks[Key] extends { request: infer Request }
    ? { request: Request }
    : PluginHooks[Key] extends { payload: infer Payload }
      ? Payload
      : never;
}[Name];
export type PluginHookResult<Name extends keyof PluginHooks> = {
  [Key in keyof PluginHooks]: PluginHooks[Key] extends { result: infer Result }
    ? Result | void
    : void;
}[Name];

type HookHandlers = {
  [Name in keyof PluginHooks]: (
    payload: PluginHookPayload<Name>,
    context: PluginHookContext,
  ) => Promise<PluginHookResult<Name>>;
};

export interface PluginLifecycleRegistration {
  addHook<Name extends keyof PluginHooks>(name: Name, handler: HookHandlers[Name]): () => void;
  /** @deprecated Use addHook with the renamed hook. Removed after 2027-04-30. */
  on<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    handler: (
      event: PluginLifecycleEvents[Name],
      context: PluginHookContext,
    ) => void | Promise<void>,
  ): () => void;
  /** @deprecated Use addHook with the renamed hook. Removed after 2027-04-30. */
  before<Name extends keyof PluginBeforeRequests>(
    name: Name,
    handler: (
      input: { request: PluginBeforeRequests[Name] },
      context: PluginHookContext,
    ) => PluginBeforeRequests[Name] | void | Promise<PluginBeforeRequests[Name] | void>,
  ): () => void;
}

const hookNames = [
  "workspace.create.prepare",
  "workspace.create.completed",
  "workspace.archive.completed",
  "agent.create.prepare",
  "agent.create.completed",
  "agent.open.prepare",
  "agent.close.completed",
  "agent.archive.completed",
  "agent.turn.started",
  "agent.turn.completed",
  "agent.permission.started",
  "agent.permission.completed",
] as const satisfies readonly (keyof PluginHooks)[];

// COMPAT(pluginHookNames): added in v0.14, remove after 2027-04-30
const legacyEvents = {
  "workspace.created": "workspace.create.completed",
  "workspace.archived": "workspace.archive.completed",
  "agent.created": "agent.create.completed",
  "agent.closed": "agent.close.completed",
  "agent.archived": "agent.archive.completed",
  "agent.turn_started": "agent.turn.started",
  "agent.turn_ended": "agent.turn.completed",
  "agent.permission_requested": "agent.permission.started",
  "agent.permission_resolved": "agent.permission.completed",
} as const;
const legacyRequests = {
  "workspace.create": "workspace.create.prepare",
  "agent.create": "agent.create.prepare",
  "agent.session_open": "agent.open.prepare",
} as const;
export type PluginLifecycleEvents = {
  [Name in keyof typeof legacyEvents]: PluginHookEvents[(typeof legacyEvents)[Name]];
};
export type PluginBeforeRequests = {
  [Name in keyof typeof legacyRequests]: PluginHookRequests[(typeof legacyRequests)[Name]];
};

/** @internal SDK adapter for the daemon's hook registry. */
export function createLifecycleRegistration(
  register: (
    name: keyof PluginHooks,
    handler: (input: never, context: PluginHookContext) => unknown,
  ) => () => void,
): PluginLifecycleRegistration {
  const names = new Set<string>(hookNames);
  return {
    addHook(name, handler) {
      if (!names.has(name)) throw new Error(`Unknown lifecycle hook: ${name}`);
      return register(name, handler);
    },
    on(name, handler) {
      if (!Object.hasOwn(legacyEvents, name)) throw new Error(`Unknown lifecycle event: ${name}`);
      return register(legacyEvents[name], handler);
    },
    before(name, handler) {
      if (!Object.hasOwn(legacyRequests, name)) throw new Error(`Unknown before hook: ${name}`);
      return register(legacyRequests[name], handler);
    },
  };
}
