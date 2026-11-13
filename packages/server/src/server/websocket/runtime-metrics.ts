import type { SessionOutboundMessage, WSOutboundMessage } from "../messages.js";
import type { ProcessMemoryDiagnostics } from "../process-diagnostics.js";

export interface WebSocketRuntimeCounters {
  connectedAwaitingHello: number;
  helloResumed: number;
  helloNew: number;
  pendingDisconnected: number;
  sessionDisconnectedWaitingReconnect: number;
  sessionSocketDisconnectedAttached: number;
  sessionCleanup: number;
  validationFailed: number;
  binaryBeforeHelloRejected: number;
  pendingMessageRejectedBeforeHello: number;
  missingConnectionForMessage: number;
  unexpectedHelloOnActiveConnection: number;
  relayExternalSocketAttached: number;
  originRejected: number;
  hostRejected: number;
  applicationJsonRejected: number;
  applicationBinaryRejected: number;
}

export interface WebSocketRuntimeMetricsSnapshot {
  windowMs: number;
  counters: WebSocketRuntimeCounters;
  inboundMessageTypesTop: Array<[string, number]>;
  inboundSessionRequestTypesTop: Array<[string, number]>;
  outboundMessageTypesTop: Array<[string, number]>;
  outboundSessionMessageTypesTop: Array<[string, number]>;
  outboundAgentStreamTypesTop: Array<[string, number]>;
  outboundAgentStreamAgentsTop: Array<[string, number]>;
  outboundBinaryFrameTypesTop: Array<[string, number]>;
  bufferedAmount: {
    p95: number;
    max: number;
  };
  latency: Array<{
    type: string;
    count: number;
    minMs: number;
    maxMs: number;
    p50Ms: number;
    totalMs: number;
  }>;
}

export interface WebSocketRuntimeDiagnosticSnapshot<
  TRuntime = unknown,
  TAgents = unknown,
  TGit = unknown,
> extends WebSocketRuntimeMetricsSnapshot {
  collectedAt: string;
  final: boolean;
  sessions: {
    activeConnections: number;
    externalSessionKeys: number;
    reconnectGraceSessions: number;
  };
  sockets: {
    activeSockets: number;
    pendingConnections: number;
  };
  eventLoopDelay: {
    p50Ms: number;
    p99Ms: number;
    maxMs: number;
  } | null;
  uptimeSeconds: number;
  memory: ProcessMemoryDiagnostics;
  runtime: TRuntime;
  agents: TAgents;
  git: TGit;
}

type Clock = () => number;

export class WebSocketRuntimeMetricsWindow {
  private windowStartedAt: number;
  private readonly counters: WebSocketRuntimeCounters = createRuntimeCounters();
  private readonly inboundMessageCounts = new Map<string, number>();
  private readonly inboundSessionRequestCounts = new Map<string, number>();
  private readonly outboundMessageCounts = new Map<string, number>();
  private readonly outboundSessionMessageCounts = new Map<string, number>();
  private readonly outboundAgentStreamCounts = new Map<string, number>();
  private readonly outboundAgentStreamByAgentCounts = new Map<string, number>();
  private readonly outboundBinaryFrameCounts = new Map<string, number>();
  private readonly bufferedAmountSamples: number[] = [];
  private readonly requestLatencies = new Map<string, number[]>();

  constructor(private readonly clock: Clock = Date.now) {
    this.windowStartedAt = this.clock();
  }

  incrementCounter(counter: keyof WebSocketRuntimeCounters): void {
    this.counters[counter] += 1;
  }

  recordInboundMessage(type: string): void {
    incrementCount(this.inboundMessageCounts, type);
  }

  recordInboundSessionRequest(type: string): void {
    incrementCount(this.inboundSessionRequestCounts, type);
  }

  recordOutboundMessage(message: WSOutboundMessage, bufferedAmount?: number): void {
    if (message.type !== "session") {
      incrementCount(this.outboundMessageCounts, message.type);
      this.recordBufferedAmount(bufferedAmount);
      return;
    }

    incrementCount(this.outboundMessageCounts, "session_message");
    incrementCount(this.outboundSessionMessageCounts, message.message.type);

    if (message.message.type === "agent_stream") {
      this.recordOutboundAgentStreamMessage(message.message.payload);
    }

    this.recordBufferedAmount(bufferedAmount);
  }

  recordOutboundBinaryFrame(bufferedAmount?: number): void {
    incrementCount(this.outboundBinaryFrameCounts, "binary");
    this.recordBufferedAmount(bufferedAmount);
  }

  recordRequestLatency(type: string, durationMs: number): void {
    let latencies = this.requestLatencies.get(type);
    if (!latencies) {
      latencies = [];
      this.requestLatencies.set(type, latencies);
    }
    latencies.push(durationMs);
  }

  /** True once agent output or a binary frame went out in the current window. */
  hasStreamActivity(): boolean {
    return this.outboundAgentStreamCounts.size > 0 || this.outboundBinaryFrameCounts.size > 0;
  }

  snapshotAndReset(): WebSocketRuntimeMetricsSnapshot {
    const now = this.clock();
    const snapshot: WebSocketRuntimeMetricsSnapshot = {
      windowMs: Math.max(0, now - this.windowStartedAt),
      counters: { ...this.counters },
      inboundMessageTypesTop: getTopCounts(this.inboundMessageCounts, 12),
      inboundSessionRequestTypesTop: getTopCounts(this.inboundSessionRequestCounts, 20),
      outboundMessageTypesTop: getTopCounts(this.outboundMessageCounts, 12),
      outboundSessionMessageTypesTop: getTopCounts(this.outboundSessionMessageCounts, 20),
      outboundAgentStreamTypesTop: getTopCounts(this.outboundAgentStreamCounts, 20),
      outboundAgentStreamAgentsTop: getTopCounts(this.outboundAgentStreamByAgentCounts, 20),
      outboundBinaryFrameTypesTop: getTopCounts(this.outboundBinaryFrameCounts, 12),
      bufferedAmount: this.computeBufferedAmountStats(),
      latency: this.computeLatencyStats(),
    };

    this.reset(now);
    return snapshot;
  }

  private recordOutboundAgentStreamMessage(
    payload: Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"],
  ): void {
    const { agentId, event } = payload;
    const eventType = event.type === "timeline" ? `timeline:${event.item.type}` : event.type;
    incrementCount(this.outboundAgentStreamCounts, eventType);
    incrementCount(this.outboundAgentStreamByAgentCounts, agentId);
  }

  private recordBufferedAmount(bufferedAmount: number | undefined): void {
    if (typeof bufferedAmount !== "number") {
      return;
    }
    this.bufferedAmountSamples.push(bufferedAmount);
  }

  private computeLatencyStats(): WebSocketRuntimeMetricsSnapshot["latency"] {
    const stats: WebSocketRuntimeMetricsSnapshot["latency"] = [];
    for (const [type, latencies] of this.requestLatencies) {
      if (latencies.length === 0) continue;
      const sortedLatencies = [...latencies].sort((a, b) => a - b);
      const count = sortedLatencies.length;
      const minMs = Math.round(sortedLatencies[0]);
      const maxMs = Math.round(sortedLatencies[count - 1]);
      const p50Ms = Math.round(sortedLatencies[Math.floor(count / 2)]);
      const totalMs = Math.round(sortedLatencies.reduce((sum, value) => sum + value, 0));
      stats.push({ type, count, minMs, maxMs, p50Ms, totalMs });
    }
    stats.sort((a, b) => b.totalMs - a.totalMs);
    return stats.slice(0, 15);
  }

  private computeBufferedAmountStats(): WebSocketRuntimeMetricsSnapshot["bufferedAmount"] {
    if (this.bufferedAmountSamples.length === 0) {
      return { p95: 0, max: 0 };
    }

    const samples = [...this.bufferedAmountSamples].sort((a, b) => a - b);
    const p95Index = Math.ceil(samples.length * 0.95) - 1;
    return {
      p95: samples[p95Index] ?? 0,
      max: samples[samples.length - 1] ?? 0,
    };
  }

  private reset(windowStartedAt: number): void {
    for (const counter of Object.keys(this.counters) as Array<keyof WebSocketRuntimeCounters>) {
      this.counters[counter] = 0;
    }
    this.inboundMessageCounts.clear();
    this.inboundSessionRequestCounts.clear();
    this.outboundMessageCounts.clear();
    this.outboundSessionMessageCounts.clear();
    this.outboundAgentStreamCounts.clear();
    this.outboundAgentStreamByAgentCounts.clear();
    this.outboundBinaryFrameCounts.clear();
    this.bufferedAmountSamples.length = 0;
    this.requestLatencies.clear();
    this.windowStartedAt = windowStartedAt;
  }
}

/** Counters that move with ordinary reconnects; alone they do not make a window notable. */
const CONNECTION_CHURN_COUNTERS: ReadonlySet<keyof WebSocketRuntimeCounters> = new Set([
  "connectedAwaitingHello",
  "helloResumed",
  "helloNew",
  "pendingDisconnected",
  "sessionDisconnectedWaitingReconnect",
  "sessionSocketDisconnectedAttached",
  "sessionCleanup",
  "relayExternalSocketAttached",
] as const);
const NOTABLE_EVENT_LOOP_DELAY_MS = 100;
const NOTABLE_REQUEST_MS = 1_000;
const NOTABLE_GIT_COMMANDS = 20;
/** Blocks that describe standing state rather than what happened during the window. */
const GAUGE_KEYS: ReadonlySet<string> = new Set([
  "sessions",
  "sockets",
  "memory",
  "runtime",
  "agents",
]);
/** Blocks whose zero values carry no information and dominate the line. */
const ZERO_ELIDED_KEYS: ReadonlySet<string> = new Set([
  "counters",
  "sessions",
  "sockets",
  "runtime",
  "git",
  "bufferedAmount",
]);

export interface RuntimeMetricsLogInput {
  final: boolean;
  counters: WebSocketRuntimeCounters;
  eventLoopDelay: { maxMs: number } | null;
  latency: Array<{ maxMs: number }>;
  git: { commands: { submitted: number }; workspaceService?: unknown };
}

/** A window worth its full state: a stall, a slow request, a Git burst, or a rejected socket. */
export function isNotableRuntimeMetricsWindow(payload: RuntimeMetricsLogInput): boolean {
  if (payload.final) return true;
  if ((payload.eventLoopDelay?.maxMs ?? 0) >= NOTABLE_EVENT_LOOP_DELAY_MS) return true;
  if (payload.latency.some((entry) => entry.maxMs >= NOTABLE_REQUEST_MS)) return true;
  if (payload.git.commands.submitted > NOTABLE_GIT_COMMANDS) return true;
  return (Object.keys(payload.counters) as Array<keyof WebSocketRuntimeCounters>).some(
    (counter) => payload.counters[counter] > 0 && !CONNECTION_CHURN_COUNTERS.has(counter),
  );
}

/**
 * The logged form of a metrics window. Zero counts, empty lists, and a false `final` are left
 * out, so a missing number reads as 0 and a missing list as empty; fractional values in those
 * blocks keep one decimal. Without gauges the standing-state blocks (sessions, sockets, memory,
 * runtime, agents, git.workspaceService) are left out too; the window's own measurements
 * (event loop delay, Git commands, latency, message counts) are always there. `elided` names
 * what was left out. The diagnostics snapshot keeps the full payload.
 */
export function compactRuntimeMetricsForLog(
  payload: RuntimeMetricsLogInput,
  options: { includeGauges: boolean },
): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!options.includeGauges && GAUGE_KEYS.has(key)) continue;
    if (key === "final" && value === false) continue;
    let next: unknown = value;
    if (key === "git" && !options.includeGauges) {
      const { workspaceService: _gauges, ...windowGit } = payload.git;
      next = windowGit;
    }
    if (ZERO_ELIDED_KEYS.has(key)) next = elideZeros(next);
    if (isEmptyContainer(next)) continue;
    compact[key] = next;
  }
  compact.elided = options.includeGauges ? "zeros" : "zeros+gauges";
  return compact;
}

function elideZeros(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : Math.round(value * 10) / 10;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const kept: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const next = elideZeros(child);
    if (next === 0 || isEmptyContainer(next)) continue;
    kept[key] = next;
  }
  return kept;
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return value !== null && typeof value === "object" && Object.keys(value).length === 0;
}

function createRuntimeCounters(): WebSocketRuntimeCounters {
  return {
    connectedAwaitingHello: 0,
    helloResumed: 0,
    helloNew: 0,
    pendingDisconnected: 0,
    sessionDisconnectedWaitingReconnect: 0,
    sessionSocketDisconnectedAttached: 0,
    sessionCleanup: 0,
    validationFailed: 0,
    binaryBeforeHelloRejected: 0,
    pendingMessageRejectedBeforeHello: 0,
    missingConnectionForMessage: 0,
    unexpectedHelloOnActiveConnection: 0,
    relayExternalSocketAttached: 0,
    originRejected: 0,
    hostRejected: 0,
    applicationJsonRejected: 0,
    applicationBinaryRejected: 0,
  };
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function getTopCounts(map: Map<string, number>, limit: number): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}
