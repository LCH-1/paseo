import {
  planTimelineCatchUpAfter,
  planTimelineResumeFetch,
  type ProjectedTimelineForwardFetchPlan,
} from "./timeline-sync-plan";
import type { CachedTimeline } from "@/runtime/replica-cache";
import {
  selectAgentTimelineState,
  useSessionStore,
  type AgentTimelineCursorState,
  type AgentTimelineState,
} from "@/stores/session-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { getSendingClientMessageIds } from "@/composer/submission/model";
import { isAgentNotFoundError } from "@/utils/agent-not-found";
import { describeErrorForLog } from "@/utils/error-messages";
import {
  getInitDeferred,
  getInitKey,
  rejectInitDeferred,
  resolveInitDeferred,
} from "@/utils/agent-initialization";
import {
  createSessionAgentStreamReducerQueue,
  type AgentStreamReducerEvent,
  type ProcessTimelineResponseOutput,
  processTimelineResponse,
} from "./session-stream-reducers";
import { isTimelineResumeSnapshotAuthoritative } from "./timeline-sync-plan";
import { replaceWithCanonicalStream } from "@/types/stream";

export interface TimelineReplicaStorage {
  readTimeline(serverId: string, agentId: string): Promise<CachedTimeline | undefined>;
  commitTimeline(serverId: string, agentId: string, timeline: CachedTimeline): void;
}

async function prepareCachedTimeline(input: {
  serverId: string;
  agentId: string;
  storage: TimelineReplicaStorage;
  prepareAgent: (agentId: string) => Promise<void>;
}): Promise<CachedTimeline | undefined> {
  const before = useSessionStore.getState().sessions[input.serverId];
  const beforeTimeline = selectAgentTimelineState(before, input.agentId);
  if (beforeTimeline.status === "synced") return undefined;
  const [stored] = await Promise.all([
    input.storage.readTimeline(input.serverId, input.agentId),
    input.prepareAgent(input.agentId),
  ]);
  if (!stored) return undefined;
  const session = useSessionStore.getState().sessions[input.serverId];
  const currentTimeline = selectAgentTimelineState(session, input.agentId);
  const currentHead = session?.agentStreamHead.get(input.agentId);
  if (currentTimeline.status === "synced") return undefined;
  if (!stored.range) {
    if (beforeTimeline.status === "painted") {
      return currentTimeline.status === "painted" && currentTimeline.items === beforeTimeline.items
        ? stored
        : undefined;
    }
    if (currentTimeline.status !== "cold") return undefined;
  }
  const liveItems =
    currentTimeline.status === "painted"
      ? [...currentTimeline.items, ...(currentHead ?? [])]
      : (currentHead ?? []);
  const replacement = replaceWithCanonicalStream({
    canonical: stored.items,
    previousTail: [],
    previousHead: liveItems,
    sendingClientMessageIds: getSendingClientMessageIds(
      session?.messageSubmissions.get(input.agentId),
    ),
    preserveContinuity: true,
    // Display-only rows claim no coverage over the live head.
    canonicalCoverage: stored.range ?? {
      epoch: liveItems.find((item) => item.timelineCursor)?.timelineCursor?.epoch ?? "",
      endSeq: null,
    },
  });
  useSessionStore.getState().applyAgentTimelineResponseState(input.serverId, input.agentId, {
    items: replacement.tail,
    head: replacement.head,
    range: stored.range,
    older: stored.hasOlder ? "available" : "none",
    newer: false,
    synchronized: false,
    acknowledgedClientMessageIds: replacement.acknowledgedClientMessageIds,
  });
  return stored;
}

export interface TimelineReplica {
  prepare(agentId: string): Promise<void>;
  readCursor(agentId: string): { epoch: string; endSeq: number } | undefined;
  readRange(agentId: string): AgentTimelineCursorState | undefined;
  timelineUpdated(agentId: string): void;
}

class TimelineReplicaOwner implements TimelineReplica {
  private readonly cachedRanges = new Map<string, AgentTimelineCursorState>();
  private readonly preparations = new Map<string, Promise<void>>();

  constructor(
    private readonly serverId: string,
    private readonly storage: TimelineReplicaStorage,
    private readonly prepareAgent: (agentId: string) => Promise<void>,
  ) {}

  async prepare(agentId: string): Promise<void> {
    const existing = this.preparations.get(agentId);
    if (existing) return existing;
    const preparation = this.load(agentId).finally(() => {
      if (this.preparations.get(agentId) === preparation) {
        this.preparations.delete(agentId);
      }
    });
    this.preparations.set(agentId, preparation);
    return preparation;
  }

  private async load(agentId: string): Promise<void> {
    const stored = await prepareCachedTimeline({
      serverId: this.serverId,
      agentId,
      storage: this.storage,
      prepareAgent: this.prepareAgent,
    });
    if (!stored) return;
    if (stored.range) {
      this.cachedRanges.set(agentId, stored.range);
    }
  }

  readCursor(agentId: string): { epoch: string; endSeq: number } | undefined {
    const range = this.cachedRanges.get(agentId);
    return range ? { epoch: range.epoch, endSeq: range.endSeq } : undefined;
  }

  readRange(agentId: string): AgentTimelineCursorState | undefined {
    return this.cachedRanges.get(agentId);
  }

  timelineUpdated(agentId: string): void {
    const session = useSessionStore.getState().sessions[this.serverId];
    const timeline = selectAgentTimelineState(session, agentId);
    if (timeline.status === "cold") return;
    if (timeline.status === "synced") this.cachedRanges.delete(agentId);
    this.storage.commitTimeline(this.serverId, agentId, {
      agentId,
      items: [...timeline.items, ...(session?.agentStreamHead.get(agentId) ?? [])],
      range: timeline.status === "synced" ? timeline.range : null,
      hasOlder: timeline.status === "synced" && timeline.older === "available",
    });
  }
}

export function createTimelineReplica(input: {
  serverId: string;
  storage: TimelineReplicaStorage;
  prepareAgent: (agentId: string) => Promise<void>;
}): TimelineReplica {
  return new TimelineReplicaOwner(input.serverId, input.storage, input.prepareAgent);
}

export interface TimelinePageResult {
  hasNewer: boolean;
  endCursor: { epoch: string; seq: number } | null;
}

export type TimelineResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_agent_timeline_response" }
>["payload"];

export function consumeForcedTimelineTailReplacement(
  payload: TimelineResponsePayload,
  replacements: Set<string>,
): TimelineResponsePayload {
  if (payload.direction !== "tail") return payload;
  if (!replacements.delete(payload.agentId)) return payload;
  return { ...payload, reset: true };
}

function clearAgentInitializingFlag(serverId: string, agentId: string): void {
  useSessionStore.getState().setInitializingAgents(serverId, (previous) => {
    if (previous.get(agentId) !== true) return previous;
    const next = new Map(previous);
    next.set(agentId, false);
    return next;
  });
}

function commitProcessedTimeline(input: {
  serverId: string;
  payload: TimelineResponsePayload;
  result: ProcessTimelineResponseOutput;
  timeline: AgentTimelineState;
  currentCursor: AgentTimelineCursorState | undefined;
  synchronized: boolean;
}): void {
  const { serverId, payload, result, timeline, currentCursor, synchronized } = input;
  const agentId = payload.agentId;
  const store = useSessionStore.getState();
  if (result.commit !== "discard") {
    store.applyAgentTimelineResponseState(serverId, agentId, {
      items: result.tail,
      head: result.head,
      range: result.cursorChanged ? (result.cursor ?? null) : (currentCursor ?? null),
      older: result.older,
      newer:
        payload.direction === "before"
          ? timeline.status === "synced" && timeline.newer === "available"
          : payload.hasNewer,
      synchronized,
      acknowledgedClientMessageIds: result.acknowledgedClientMessageIds,
    });
    return;
  }
  if (result.acknowledgedClientMessageIds.length > 0) {
    store.setAgentStreamState(serverId, agentId, {
      acknowledgedClientMessageIds: result.acknowledgedClientMessageIds,
    });
  }
  if (payload.direction !== "before") {
    store.setAgentTimelineHasNewer(serverId, (current) => {
      const next = new Map(current);
      next.set(agentId, payload.hasNewer);
      return next;
    });
  }
  store.markAgentHistorySynchronized(serverId, agentId);
}

function finalizeProcessedTimeline(input: {
  serverId: string;
  agentId: string;
  initKey: string;
  result: ProcessTimelineResponseOutput;
  synchronized: boolean;
  recoverGap: (agentId: string, cursor: { epoch: string; endSeq: number }) => void;
  drainQueuedAgentMessage: (agentId: string) => void;
}): void {
  for (const effect of input.result.sideEffects) {
    if (effect.type === "catch_up") input.recoverGap(input.agentId, effect.cursor);
  }
  if (input.result.clearInitializing) {
    clearAgentInitializingFlag(input.serverId, input.agentId);
  }
  if (input.synchronized) {
    const session = useSessionStore.getState().sessions[input.serverId];
    const agent = session?.agents.get(input.agentId) ?? session?.agentDetails.get(input.agentId);
    if (agent && agent.turn.phase === "idle") input.drainQueuedAgentMessage(input.agentId);
  }
  if (input.result.initResolution === "resolve") resolveInitDeferred(input.initKey);
}

function applyAuthoritativeTimelineResponse(input: {
  serverId: string;
  payload: TimelineResponsePayload;
  cachedCursor?: AgentTimelineCursorState;
  recoverGap: (agentId: string, cursor: { epoch: string; endSeq: number }) => void;
  drainQueuedAgentMessage: (agentId: string) => void;
}): boolean {
  const { serverId, payload } = input;
  const agentId = payload.agentId;
  const initKey = getInitKey(serverId, agentId);
  const session = useSessionStore.getState().sessions[serverId];
  const timeline = selectAgentTimelineState(session, agentId);
  const activeInitDeferred = getInitDeferred(initKey);
  const currentCursor =
    timeline.status === "synced" ? (timeline.range ?? undefined) : input.cachedCursor;
  const result = processTimelineResponse({
    payload,
    currentTail: timeline.status === "cold" ? [] : timeline.items,
    currentHead: session?.agentStreamHead.get(agentId) ?? [],
    currentCursor,
    isInitializing: session?.initializingAgents.get(agentId) === true,
    hasActiveInitDeferred: Boolean(activeInitDeferred),
    initRequestDirection: activeInitDeferred?.requestDirection ?? "tail",
    sendingClientMessageIds: getSendingClientMessageIds(session?.messageSubmissions.get(agentId)),
  });

  if (result.error) {
    if (result.clearInitializing) clearAgentInitializingFlag(serverId, agentId);
    if (result.initResolution === "reject") rejectInitDeferred(initKey, new Error(result.error));
    return false;
  }

  const synchronized = isTimelineResumeSnapshotAuthoritative({
    direction: payload.direction,
    hasNewer: payload.hasNewer,
    error: payload.error,
  });
  commitProcessedTimeline({ serverId, payload, result, timeline, currentCursor, synchronized });
  finalizeProcessedTimeline({
    serverId,
    agentId,
    initKey,
    result,
    synchronized,
    recoverGap: input.recoverGap,
    drainQueuedAgentMessage: input.drainQueuedAgentMessage,
  });
  return true;
}

/** The chats a reported failure belongs to. Absent when the failure is not tied to a chat. */
export interface ViewedTimelineSyncErrorScope {
  agentIds: string[];
}

export function describeViewedTimelineSyncFailure(input: {
  serverId: string;
  error: unknown;
  scope?: ViewedTimelineSyncErrorScope;
}): string {
  const parts = [`serverId=${input.serverId}`];
  if (input.scope) parts.push(`agentIds=${input.scope.agentIds.join(",")}`);
  parts.push(describeErrorForLog(input.error));
  return parts.join(" ");
}

export interface ViewedTimelineSyncPorts {
  prepare(agentId: string): Promise<void>;
  replaceDemandedAgentIds(agentIds: string[]): void;
  observe(agentIds: string[]): { ready: Promise<unknown>; release(): Promise<void> };
  readCursor(agentId: string): { epoch: string; endSeq: number } | undefined;
  fetchPage(
    agentId: string,
    request: ProjectedTimelineForwardFetchPlan,
  ): Promise<TimelinePageResult>;
  fetchLatestTail(agentId: string): Promise<TimelinePageResult>;
  /**
   * The sync no longer owes this chat a catch-up: it reached current, or it left the
   * demanded set. Disconnect and backgrounding keep the obligation and do not report here.
   */
  onCatchUpEnded(agentId: string): void;
  reportError(error: unknown, scope?: ViewedTimelineSyncErrorScope): void;
  onAgentDeleted?(agentId: string): void;
  schedule(task: () => void, delayMs: number): () => void;
}

export type ViewedTimelineStatus = "ready" | "pending" | "error" | "retrying";

export interface ViewedTimelineUiBridge {
  replaceVisibleAgentIds(sourceId: string, agentIds: string[]): void;
  subscribe(listener: () => void): () => void;
  getAgentTimelineStatus(agentId: string): ViewedTimelineStatus;
  getAgentTimelineError(agentId: string): string | null;
  retryVisibleAgentTimeline(agentId: string): void;
}

export interface ViewedTimelineSync extends ViewedTimelineUiBridge {
  forgetAgent(agentId: string): void;
  isAgentDeleted(agentId: string): boolean;
  /**
   * The agent tabs that currently exist in workspace layout. This only ever *releases*
   * subscriptions: closing a tab drops its chat. It never adds one, because layout is
   * restored from disk at launch and those tabs are chats the user opened days ago.
   */
  replaceOpenTabAgentIds(agentIds: string[]): void;
  setActive(active: boolean): void;
  setConnected(connected: boolean): void;
  recoverGap(agentId: string, cursor: { epoch: string; endSeq: number }): void;
  dispose(): void;
}

export type ViewedTimelineOwnerPorts = Omit<
  ViewedTimelineSyncPorts,
  "prepare" | "replaceDemandedAgentIds" | "onCatchUpEnded"
>;

export interface ViewedTimelineOwner extends ViewedTimelineSync {
  applyTimelineResponse(payload: TimelineResponsePayload): void;
  enqueueStreamEvent(agentId: string, event: AgentStreamReducerEvent): void;
  flushStreamAgent(agentId: string): void;
  /**
   * Marks the chat's rows as read by a view on screen until the returned function runs.
   * Meanwhile no release starts, and one still waiting for its page applies that page as an
   * ordinary tail, so a reader who came back keeps every row.
   */
  retainHistory(agentId: string): () => void;
  /**
   * Replaces the chat's in-memory timeline with the daemon's latest page, so a long stream
   * nobody is reading stops holding every row it ever received. Older rows stay available
   * and load again when scrolled to. The caller decides that no one reads the dropped rows.
   * Resolves to whether the page replaced the timeline. Views asking while a release is on its
   * way share it, so each of them learns that the rows were replaced.
   */
  releaseRetainedHistory(agentId: string): Promise<boolean>;
}

export function createViewedTimelineOwner(input: {
  serverId: string;
  replica: TimelineReplica;
  replaceDemandedAgentIds: (agentIds: string[]) => void;
  drainQueuedAgentMessage: (agentId: string) => void;
  ports: ViewedTimelineOwnerPorts;
}): ViewedTimelineOwner {
  const forcedTailReplacements = new Set<string>();
  const deletedAgentIds = new Set<string>();
  const historyHolds = new Map<string, number>();
  const historyReleases = new Map<string, { replaced: boolean }>();
  const runningReleases = new Map<string, Promise<boolean>>();
  const sync = createViewedTimelineSync({
    ...input.ports,
    onAgentDeleted: (agentId) => {
      deletedAgentIds.add(agentId);
      input.ports.onAgentDeleted?.(agentId);
    },
    fetchLatestTail: async (agentId) => {
      forcedTailReplacements.add(agentId);
      try {
        return await input.ports.fetchLatestTail(agentId);
      } finally {
        forcedTailReplacements.delete(agentId);
      }
    },
    prepare: (agentId) => input.replica.prepare(agentId),
    readCursor: (agentId) => input.replica.readCursor(agentId) ?? input.ports.readCursor(agentId),
    replaceDemandedAgentIds: input.replaceDemandedAgentIds,
    onCatchUpEnded: (agentId) =>
      useCreateFlowStore.getState().clearByAgent({ serverId: input.serverId, agentId }),
  });
  const streamQueue = createSessionAgentStreamReducerQueue({
    serverId: input.serverId,
    setAgentStreamState: (serverId, agentId, state) => {
      if (!deletedAgentIds.has(agentId))
        useSessionStore.getState().setAgentStreamState(serverId, agentId, state);
    },
    setAgentTimelineCursor: (serverId, update) =>
      useSessionStore.getState().setAgentTimelineCursor(serverId, (previous) => {
        const next = update(previous);
        let retained = next;
        for (const agentId of deletedAgentIds) {
          if (!retained.has(agentId)) continue;
          if (retained === next) retained = new Map(next);
          retained.delete(agentId);
        }
        return retained;
      }),
    recoverTimelineGap: (agentId, cursor) => {
      if (!deletedAgentIds.has(agentId)) sync.recoverGap(agentId, cursor);
    },
    onCommitted: (agentId) => {
      if (!deletedAgentIds.has(agentId)) input.replica.timelineUpdated(agentId);
    },
  });
  return {
    ...sync,
    forgetAgent(agentId) {
      deletedAgentIds.add(agentId);
      sync.forgetAgent(agentId);
    },
    applyTimelineResponse(receivedPayload) {
      if (sync.isAgentDeleted(receivedPayload.agentId)) return;
      const release =
        receivedPayload.direction === "tail"
          ? historyReleases.get(receivedPayload.agentId)
          : undefined;
      if (release) historyReleases.delete(receivedPayload.agentId);
      const forced = consumeForcedTimelineTailReplacement(receivedPayload, forcedTailReplacements);
      const payload = release ? { ...forced, reset: true } : forced;
      const accepted = applyAuthoritativeTimelineResponse({
        serverId: input.serverId,
        payload,
        cachedCursor: input.replica.readRange(payload.agentId),
        recoverGap: (agentId, cursor) => sync.recoverGap(agentId, cursor),
        drainQueuedAgentMessage: input.drainQueuedAgentMessage,
      });
      if (release) release.replaced = accepted;
      if (accepted) input.replica.timelineUpdated(payload.agentId);
    },
    enqueueStreamEvent(agentId, event) {
      if (sync.isAgentDeleted(agentId)) return;
      streamQueue.enqueue(agentId, event);
    },
    flushStreamAgent(agentId) {
      streamQueue.flushAgent(agentId);
    },
    retainHistory(agentId) {
      historyHolds.set(agentId, (historyHolds.get(agentId) ?? 0) + 1);
      historyReleases.delete(agentId);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        const holds = (historyHolds.get(agentId) ?? 1) - 1;
        if (holds > 0) historyHolds.set(agentId, holds);
        else historyHolds.delete(agentId);
      };
    },
    releaseRetainedHistory(agentId) {
      if (sync.isAgentDeleted(agentId) || historyHolds.has(agentId)) {
        return Promise.resolve(false);
      }
      const running = runningReleases.get(agentId);
      if (running) return running;
      const release = { replaced: false };
      const replaceWithLatestPage = async () => {
        streamQueue.flushAgent(agentId);
        historyReleases.set(agentId, release);
        try {
          await input.ports.fetchLatestTail(agentId);
        } finally {
          if (historyReleases.get(agentId) === release) historyReleases.delete(agentId);
        }
        return release.replaced;
      };
      const run = replaceWithLatestPage().finally(() => {
        if (runningReleases.get(agentId) === run) runningReleases.delete(agentId);
      });
      runningReleases.set(agentId, run);
      return run;
    },
    dispose() {
      streamQueue.dispose({ flush: true });
      sync.dispose();
    },
  };
}

const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

type CatchUpStatus = "running" | "complete" | "error";

interface CatchUpState {
  generation: number;
  status: CatchUpStatus;
  request?: ProjectedTimelineForwardFetchPlan;
  cancelRetry?: () => void;
  retryDelayMs?: number;
}

const getNextRetryDelayMs = (previousDelayMs: number | undefined): number => {
  if (previousDelayMs == null) {
    return RETRY_DELAY_MS;
  }
  return Math.min(previousDelayMs * 2, MAX_RETRY_DELAY_MS);
};

function isSameCatchUpRequest(
  left: ProjectedTimelineForwardFetchPlan | undefined,
  right: ProjectedTimelineForwardFetchPlan | undefined,
): boolean {
  if (!left || !right || left.direction !== right.direction) return false;
  if (left.direction !== "after" || right.direction !== "after") return true;
  return left.cursor.epoch === right.cursor.epoch && left.cursor.seq === right.cursor.seq;
}

type CatchUpDecision = "keep" | "keep-and-park" | "replace";

function decideCatchUp(input: {
  current: CatchUpState | undefined;
  request: ProjectedTimelineForwardFetchPlan;
  supersede: boolean;
}): CatchUpDecision {
  if (!input.current) return "replace";
  if (input.supersede) {
    if (
      input.current.status === "running" &&
      isSameCatchUpRequest(input.current.request, input.request)
    ) {
      return "keep";
    }
    if (input.current.status === "running" && input.current.request?.direction === "tail") {
      return "keep-and-park";
    }
    return "replace";
  }
  return input.current.status === "running" || input.current.status === "complete"
    ? "keep"
    : "replace";
}

function normalizeAgentIds(agentIds: string[]): string[] {
  return [...new Set(agentIds)].filter(Boolean).sort();
}

function sameAgentIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((agentId, index) => agentId === right[index]);
}

export function createViewedTimelineSync(ports: ViewedTimelineSyncPorts): ViewedTimelineSync {
  const sources = new Map<string, string[]>();
  const deletedAgentIds = new Set<string>();
  const catchUps = new Map<string, CatchUpState>();
  const catchUpGenerations = new Map<string, number>();
  // Authoritative fetch owed but not runnable yet: disconnected, unacknowledged, or parked.
  // Membership acknowledgement and catch-up completion drain parked requests.
  const pendingCatchUps = new Map<string, ProjectedTimelineForwardFetchPlan>();
  const visibilityCatchUpPending = new Set<string>();
  const visibilityCatchUpErrors = new Map<string, string>();
  // User-initiated retries only. Background retries stay silent; a retry the user asked for
  // owes them a pending state until it settles.
  const manualRetries = new Set<string>();
  const loadedCache = new Set<string>();
  const cacheLoads = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let active = true;
  let connected = false;
  let observation: {
    handle: ReturnType<ViewedTimelineSyncPorts["observe"]>;
    agentIds: string[];
  } | null = null;
  let disposed = false;
  let desired: string[] = [];
  let acknowledged: string[] = [];
  let membershipGeneration = 0;
  let membershipNeedsRetry = false;
  let membershipRetryDelayMs: number | undefined;
  let cancelMembershipRetry: (() => void) | null = null;
  // Chats this session has opened. Visibility is the only way in, so an agent is never
  // subscribed — and never resumed on the daemon — until the user actually opens it.
  // Membership then survives hiding, workspace switches, backgrounding and reconnect;
  // only closing the tab or ending the session takes it out.
  let openedAgentIds: string[] = [];

  const visibleAgentIds = () =>
    normalizeAgentIds([...sources.values()].flat()).filter((id) => !deletedAgentIds.has(id));

  const rememberOpenedAgentIds = (agentIds: string[]) => {
    if (agentIds.length === 0) return;
    const next = normalizeAgentIds([...openedAgentIds, ...agentIds]);
    if (sameAgentIds(next, openedAgentIds)) return;
    openedAgentIds = next;
  };

  const isAcknowledged = (agentId: string) => acknowledged.includes(agentId);
  const isDesired = (agentId: string) => desired.includes(agentId);
  const canCatchUp = (agentId: string) =>
    !disposed && connected && isDesired(agentId) && isAcknowledged(agentId);
  const ownsCatchUp = (agentId: string, generation: number) =>
    canCatchUp(agentId) && catchUps.get(agentId)?.generation === generation;

  const notifyListeners = () => {
    for (const listener of listeners) listener();
  };

  const setVisibilityCatchUpReady = (agentId: string) => {
    const wasPending = visibilityCatchUpPending.delete(agentId);
    const hadError = visibilityCatchUpErrors.delete(agentId);
    const wasRetrying = manualRetries.delete(agentId);
    ports.onCatchUpEnded(agentId);
    if (wasPending || hadError || wasRetrying) notifyListeners();
  };

  const setVisibilityCatchUpError = (agentIds: string[], error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    let changed = false;
    for (const agentId of agentIds) {
      if (manualRetries.delete(agentId)) changed = true;
      if (visibilityCatchUpPending.delete(agentId)) changed = true;
      if (visibilityCatchUpErrors.get(agentId) !== message) {
        visibilityCatchUpErrors.set(agentId, message);
        changed = true;
      }
    }
    if (changed) notifyListeners();
  };

  const cancelCatchUp = (agentId: string) => {
    catchUpGenerations.set(agentId, (catchUpGenerations.get(agentId) ?? 0) + 1);
    catchUps.get(agentId)?.cancelRetry?.();
    catchUps.delete(agentId);
    pendingCatchUps.delete(agentId);
  };

  const fetchUntilCurrent = async (
    agentId: string,
    generation: number,
    request: ProjectedTimelineForwardFetchPlan,
    fallbackToLatestTailOnOverflow: boolean,
  ): Promise<void> => {
    if (!ownsCatchUp(agentId, generation)) return;

    try {
      const page = await ports.fetchPage(agentId, request);
      if (!ownsCatchUp(agentId, generation)) return;
      if (page.hasNewer && page.endCursor) {
        if (fallbackToLatestTailOnOverflow) {
          await ports.fetchLatestTail(agentId);
          if (!ownsCatchUp(agentId, generation)) return;
          catchUps.set(agentId, { generation, status: "complete" });
          setVisibilityCatchUpReady(agentId);
          return;
        }
        await fetchUntilCurrent(
          agentId,
          generation,
          planTimelineCatchUpAfter(page.endCursor),
          false,
        );
        return;
      }
      if (page.hasNewer) {
        throw new Error(`Timeline page for ${agentId} hasNewer without an end cursor`);
      }
      catchUps.set(agentId, { generation, status: "complete" });
      const pendingCatchUp = pendingCatchUps.get(agentId);
      if (pendingCatchUp) {
        startCatchUp(agentId, { request: pendingCatchUp, supersede: true });
        return;
      }
      setVisibilityCatchUpReady(agentId);
    } catch (error) {
      if (!ownsCatchUp(agentId, generation)) return;
      if (isAgentNotFoundError(error)) {
        forgetAgent(agentId);
        ports.onAgentDeleted?.(agentId);
        return;
      }
      if (catchUps.get(agentId)?.generation === generation) {
        const nextRetryDelayMs = getNextRetryDelayMs(catchUps.get(agentId)?.retryDelayMs);
        const cancelRetry = ports.schedule(() => {
          const current = catchUps.get(agentId);
          if (current?.generation !== generation || current.status !== "error") return;
          startCatchUp(agentId);
        }, nextRetryDelayMs);
        catchUps.set(agentId, {
          generation,
          status: "error",
          request,
          cancelRetry,
          retryDelayMs: nextRetryDelayMs,
        });
        setVisibilityCatchUpError([agentId], error);
        ports.reportError(error, { agentIds: [agentId] });
      }
    } finally {
      startAcknowledgedCatchUps();
    }
  };

  const ensureCacheLoaded = (agentId: string): void => {
    if (loadedCache.has(agentId) || cacheLoads.has(agentId)) return;
    const load = ports
      .prepare(agentId)
      .catch((error) => ports.reportError(error, { agentIds: [agentId] }))
      .finally(() => {
        cacheLoads.delete(agentId);
        loadedCache.add(agentId);
        const pending = pendingCatchUps.get(agentId);
        startCatchUp(agentId, { request: pending, supersede: Boolean(pending) });
      });
    cacheLoads.set(agentId, load);
  };

  // Existing streams and retries continue; only initial hidden catch-ups wait.
  const shouldWaitForVisibleCatchUp = (agentId: string) => {
    if (!active || catchUps.has(agentId)) return false;
    const visible = visibleAgentIds();
    return (
      !visible.includes(agentId) &&
      visible.some((id) => {
        const status = catchUps.get(id)?.status;
        return isDesired(id) && (status === undefined || status === "running");
      })
    );
  };

  const startCatchUp = (
    agentId: string,
    options: {
      request?: ProjectedTimelineForwardFetchPlan;
      supersede?: boolean;
    } = {},
  ) => {
    const { request, supersede = false } = options;
    if (!canCatchUp(agentId)) {
      if (request) pendingCatchUps.set(agentId, request);
      return;
    }
    if (shouldWaitForVisibleCatchUp(agentId)) {
      if (request) pendingCatchUps.set(agentId, request);
      return;
    }
    if (!loadedCache.has(agentId)) {
      if (request) pendingCatchUps.set(agentId, request);
      ensureCacheLoaded(agentId);
      return;
    }
    const nextRequest = request ?? planTimelineResumeFetch(ports.readCursor(agentId));
    const current = catchUps.get(agentId);
    const decision = decideCatchUp({ current, request: nextRequest, supersede });
    if (decision === "keep-and-park") {
      pendingCatchUps.set(agentId, nextRequest);
      return;
    }
    if (decision === "keep") {
      return;
    }
    current?.cancelRetry?.();
    const generation = (catchUpGenerations.get(agentId) ?? 0) + 1;
    catchUpGenerations.set(agentId, generation);
    // Returning to the app, gap recovery and a manual retry each earn one immediate attempt,
    // not a new failure streak. Only a completed or cancelled catch-up forgets the backoff.
    const retryDelayMs = current?.retryDelayMs;
    catchUps.set(agentId, {
      generation,
      status: "running",
      request: nextRequest,
      retryDelayMs,
    });
    pendingCatchUps.delete(agentId);
    void fetchUntilCurrent(
      agentId,
      generation,
      nextRequest,
      request === undefined && nextRequest.direction === "after",
    );
  };

  const startAcknowledgedCatchUps = () => {
    const visible = visibleAgentIds();
    const ordered = [
      ...visible.filter(isAcknowledged),
      ...acknowledged.filter((id) => !visible.includes(id)),
    ];
    for (const agentId of ordered) {
      const pendingCatchUp = pendingCatchUps.get(agentId);
      const current = catchUps.get(agentId);
      // Completion of a different chat must not bypass a failed chat's backoff or
      // supersede an in-flight tail that owns its parked gap recovery.
      if (current && !(current.status === "complete" && pendingCatchUp)) continue;
      startCatchUp(agentId, {
        request: pendingCatchUp,
        supersede: Boolean(pendingCatchUp),
      });
    }
  };

  const reconcileMembership = async (): Promise<void> => {
    if (disposed || !connected) return;
    const generation = membershipGeneration;
    const requested = desired;
    if (!membershipNeedsRetry && sameAgentIds(requested, observation?.agentIds ?? acknowledged))
      return;
    membershipNeedsRetry = false;
    try {
      const previous = observation;
      const handle = ports.observe(requested);
      observation = { handle, agentIds: requested };
      void previous?.handle.release().catch(ports.reportError);
      await handle.ready;
    } catch (error) {
      if (disposed || !connected || generation !== membershipGeneration) return;
      membershipNeedsRetry = true;
      setVisibilityCatchUpError(requested, error);
      cancelMembershipRetry?.();
      const nextRetryDelayMs = getNextRetryDelayMs(membershipRetryDelayMs);
      cancelMembershipRetry = ports.schedule(() => {
        cancelMembershipRetry = null;
        if (disposed || !connected || membershipGeneration !== generation) return;
        void reconcileMembership();
      }, nextRetryDelayMs);
      membershipRetryDelayMs = nextRetryDelayMs;
      ports.reportError(error, { agentIds: requested });
      return;
    }
    if (disposed || !connected || generation !== membershipGeneration) return;
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    membershipRetryDelayMs = undefined;
    acknowledged = requested;
    startAcknowledgedCatchUps();
  };

  const retryVisibleAgentTimeline = (agentId: string) => {
    if (!isDesired(agentId) || manualRetries.has(agentId)) return;
    const catchUp = catchUps.get(agentId);
    const membershipRetryable = membershipNeedsRetry && connected;
    if (catchUp?.status !== "error" && !membershipRetryable) return;
    manualRetries.add(agentId);
    notifyListeners();
    if (catchUp?.status === "error") {
      catchUp.cancelRetry?.();
      startCatchUp(agentId, { request: catchUp.request, supersede: true });
      return;
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    membershipRetryDelayMs = undefined;
    void reconcileMembership();
  };

  const commitDesiredMembership = (
    nextDesired: string[],
    options: { resetCatchUpStatus?: boolean } = {},
  ) => {
    let statusChanged = false;
    if (options.resetCatchUpStatus) {
      for (const agentId of nextDesired) {
        if (!visibilityCatchUpPending.has(agentId)) {
          visibilityCatchUpPending.add(agentId);
          statusChanged = true;
        }
        if (visibilityCatchUpErrors.delete(agentId)) statusChanged = true;
        if (manualRetries.delete(agentId)) statusChanged = true;
      }
    }
    if (sameAgentIds(nextDesired, desired)) {
      if (statusChanged) notifyListeners();
      return;
    }

    const released: string[] = [];
    for (const agentId of desired) {
      if (!nextDesired.includes(agentId)) {
        cancelCatchUp(agentId);
        visibilityCatchUpPending.delete(agentId);
        visibilityCatchUpErrors.delete(agentId);
        manualRetries.delete(agentId);
        released.push(agentId);
      }
    }
    for (const agentId of nextDesired) {
      if (!desired.includes(agentId)) {
        visibilityCatchUpPending.add(agentId);
        visibilityCatchUpErrors.delete(agentId);
        manualRetries.delete(agentId);
        ensureCacheLoaded(agentId);
      }
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    desired = nextDesired;
    ports.replaceDemandedAgentIds(desired);
    membershipGeneration += 1;
    for (const agentId of released) ports.onCatchUpEnded(agentId);
    notifyListeners();
    void reconcileMembership();
  };

  const publishVisibleMembership = () => {
    commitDesiredMembership(normalizeAgentIds([...openedAgentIds, ...visibleAgentIds()]));
  };

  const forgetAgent = (agentId: string) => {
    deletedAgentIds.add(agentId);
    openedAgentIds = openedAgentIds.filter((id) => id !== agentId);
    for (const [source, ids] of sources) {
      const remaining = ids.filter((id) => id !== agentId);
      if (remaining.length) sources.set(source, remaining);
      else sources.delete(source);
    }
    cancelCatchUp(agentId);
    loadedCache.delete(agentId);
    visibilityCatchUpPending.delete(agentId);
    visibilityCatchUpErrors.delete(agentId);
    manualRetries.delete(agentId);
    publishVisibleMembership();
    notifyListeners();
  };

  return {
    forgetAgent,
    isAgentDeleted: (agentId) => deletedAgentIds.has(agentId),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAgentTimelineStatus(agentId) {
      if (deletedAgentIds.has(agentId)) return "error";
      if (manualRetries.has(agentId)) return "retrying";
      if (visibilityCatchUpErrors.has(agentId)) return "error";
      if (!isDesired(agentId) || visibilityCatchUpPending.has(agentId)) return "pending";
      return "ready";
    },
    getAgentTimelineError(agentId) {
      if (deletedAgentIds.has(agentId)) return "This conversation was deleted.";
      return visibilityCatchUpErrors.get(agentId) ?? null;
    },
    replaceOpenTabAgentIds(agentIds) {
      const openTabs = new Set(agentIds);
      const next = openedAgentIds.filter((agentId) => openTabs.has(agentId));
      if (sameAgentIds(next, openedAgentIds)) return;
      openedAgentIds = next;
      publishVisibleMembership();
    },
    replaceVisibleAgentIds(sourceId, agentIds) {
      const normalized = normalizeAgentIds(agentIds).filter((id) => !deletedAgentIds.has(id));
      if (normalized.length === 0) sources.delete(sourceId);
      else sources.set(sourceId, normalized);
      rememberOpenedAgentIds(normalized);
      publishVisibleMembership();
      startAcknowledgedCatchUps();
    },
    setActive(nextActive) {
      if (active === nextActive) return;
      active = nextActive;
      publishVisibleMembership();
      if (!active) {
        startAcknowledgedCatchUps();
        return;
      }
      for (const agentId of visibleAgentIds()) {
        visibilityCatchUpPending.add(agentId);
        visibilityCatchUpErrors.delete(agentId);
        startCatchUp(agentId, { supersede: true });
      }
      notifyListeners();
    },
    setConnected(nextConnected) {
      if (connected === nextConnected) return;
      connected = nextConnected;
      if (!connected) {
        commitDesiredMembership(desired, { resetCatchUpStatus: true });
        cancelMembershipRetry?.();
        cancelMembershipRetry = null;
        membershipRetryDelayMs = undefined;
        void observation?.handle.release().catch(ports.reportError);
        observation = null;
        acknowledged = [];
        membershipGeneration += 1;
        for (const agentId of desired) cancelCatchUp(agentId);
        return;
      }
      membershipGeneration += 1;
      void reconcileMembership();
    },
    recoverGap(agentId, cursor) {
      if (!isDesired(agentId)) return;
      startCatchUp(agentId, {
        request: planTimelineCatchUpAfter({ epoch: cursor.epoch, seq: cursor.endSeq }),
        supersede: true,
      });
    },
    dispose() {
      disposed = true;
      void observation?.handle.release().catch(ports.reportError);
      observation = null;
      cancelMembershipRetry?.();
      cancelMembershipRetry = null;
      membershipNeedsRetry = false;
      membershipRetryDelayMs = undefined;
      sources.clear();
      membershipGeneration += 1;
      for (const agentId of desired) cancelCatchUp(agentId);
      desired = [];
      ports.replaceDemandedAgentIds([]);
      acknowledged = [];
      openedAgentIds = [];
      loadedCache.clear();
      cacheLoads.clear();
      visibilityCatchUpPending.clear();
      visibilityCatchUpErrors.clear();
      manualRetries.clear();
      notifyListeners();
      listeners.clear();
    },
    retryVisibleAgentTimeline,
  };
}
