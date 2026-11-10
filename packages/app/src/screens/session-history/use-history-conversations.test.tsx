/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { queryClient } from "@/data/query-client";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { EMPTY_CONVERSATION } from "./conversation-summary";
import {
  createHistoryLiveSelector,
  createHistoryRowsBuilder,
  useHistoryConversations,
} from "./use-history-conversations";

const runtime = vi.hoisted(() => ({
  client: null as { fetchAgentTimeline: (...args: unknown[]) => Promise<unknown> } | null,
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => runtime.client }),
}));

const HOST = "host";
const OTHER_HOST = "other-host";
const REQUESTED_AT = new Date("2026-11-10T00:00:00.000Z");
const RESPONDED_AT = new Date("2026-11-10T00:01:00.000Z");

function makeAgent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  return {
    serverId: HOST,
    provider: "codex",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: REQUESTED_AT,
    updatedAt: REQUESTED_AT,
    lastUserMessageAt: REQUESTED_AT,
    lastActivityAt: REQUESTED_AT,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: input.id,
    cwd: "/repo",
    model: null,
    parentAgentId: null,
    labels: {},
    ...input,
  };
}

function listed(agent: Agent): AggregatedAgent {
  return {
    id: agent.id,
    serverId: agent.serverId,
    serverLabel: "Host",
    title: agent.title,
    status: agent.status,
    turn: agent.turn,
    lastActivityAt: agent.lastActivityAt,
    lastUserMessageAt: agent.lastUserMessageAt,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    provider: agent.provider,
    pendingPermissionCount: 0,
    createdAt: agent.createdAt,
    labels: agent.labels,
  };
}

function seed(agents: Agent[]): AggregatedAgent[] {
  const store = useSessionStore.getState();
  store.initializeSession(HOST, null as unknown as DaemonClient);
  store.initializeSession(OTHER_HOST, null as unknown as DaemonClient);
  store.setAgents(HOST, new Map(agents.map((agent) => [agent.id, agent])));
  return agents.map(listed);
}

function replaceAgent(agent: Agent): void {
  useSessionStore
    .getState()
    .setAgents(agent.serverId, (current) => new Map(current).set(agent.id, agent));
}

function assistantMessage(text: string, timestamp = RESPONDED_AT): StreamItem {
  return { kind: "assistant_message", id: "message", text, timestamp };
}

function streamTick(serverId: string, agentId: string, head: StreamItem[]): void {
  useSessionStore.getState().setAgentStreamState(serverId, agentId, { head });
}

function timelinePage(text: string, respondedAt: Date) {
  return {
    agent: { lastUserMessageAt: REQUESTED_AT.toISOString() },
    entries: [{ item: { type: "assistant_message", text }, timestamp: respondedAt.toISOString() }],
    hasOlder: false,
    startCursor: null,
  };
}

// The app's query defaults never refetch a cached key on mount or focus, so a row's
// summary only moves when its key does. Keep those defaults on a cache of its own.
function createQueryCache(): QueryClient {
  return new QueryClient({ defaultOptions: queryClient.getDefaultOptions() });
}

function renderConversations(initial: AggregatedAgent[], client = createQueryCache()) {
  const counter = { renders: 0, loading: [] as boolean[] };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ agents }: { agents: AggregatedAgent[] }) => {
      counter.renders += 1;
      const conversations = useHistoryConversations(agents);
      counter.loading.push(conversations.isLoading);
      return conversations;
    },
    { wrapper, initialProps: { agents: initial } },
  );
  return { ...hook, counter };
}

const MINUTES = 60_000;
const runningAgent = (lastActivityAt = REQUESTED_AT) =>
  makeAgent({
    id: "running",
    status: "running",
    turn: { phase: "open", turnId: "turn", startedAt: null, cancellationRequestId: null },
    lastActivityAt,
  });
const activityAfter = (seconds: number) => new Date(REQUESTED_AT.getTime() + seconds * 1000);

function reportActivity(
  rerender: (props: { agents: AggregatedAgent[] }) => void,
  at: Date,
  others: AggregatedAgent[] = [],
): void {
  const next = runningAgent(at);
  act(() => {
    replaceAgent(next);
    rerender({ agents: [listed(next), ...others] });
  });
}

beforeEach(() => {
  runtime.client = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSessionStore.getState().clearSession(HOST);
  useSessionStore.getState().clearSession(OTHER_HOST);
});

describe("createHistoryLiveSelector", () => {
  class LookupCountingMap<K, V> extends Map<K, V> {
    lookups = 0;
    override get(key: K) {
      this.lookups += 1;
      return super.get(key);
    }
  }

  it("returns the same entries while agents outside the list stream", () => {
    const agents = seed([makeAgent({ id: "listed" }), makeAgent({ id: "unlisted" })]).slice(0, 1);
    const select = createHistoryLiveSelector(agents);
    const before = select(useSessionStore.getState());

    for (let tick = 0; tick < 100; tick += 1) {
      streamTick(tick % 2 ? HOST : OTHER_HOST, "unlisted", [assistantMessage(`token ${tick}`)]);
      expect(select(useSessionStore.getState())).toBe(before);
    }
  });

  it("does not read a listed host while only another host streams", () => {
    const hostAgents = new LookupCountingMap<string, Agent>([
      ["listed", makeAgent({ id: "listed" })],
    ]);
    const store = useSessionStore.getState();
    store.initializeSession(HOST, null as unknown as DaemonClient);
    store.initializeSession(OTHER_HOST, null as unknown as DaemonClient);
    store.setAgents(HOST, hostAgents);
    const select = createHistoryLiveSelector([listed(makeAgent({ id: "listed" }))]);
    const before = select(useSessionStore.getState());
    const lookups = hostAgents.lookups;

    for (let tick = 0; tick < 100; tick += 1) {
      streamTick(OTHER_HOST, "elsewhere", [assistantMessage(`token ${tick}`)]);
      expect(select(useSessionStore.getState())).toBe(before);
    }

    expect(hostAgents.lookups).toBe(lookups);
  });

  it("replaces only the entry whose conversation changed", () => {
    const agents = seed([makeAgent({ id: "a" }), makeAgent({ id: "b" })]);
    const select = createHistoryLiveSelector(agents);
    const before = select(useSessionStore.getState());

    streamTick(HOST, "a", [assistantMessage("answer")]);
    const after = select(useSessionStore.getState());

    expect(after).not.toBe(before);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0].head.preview).toBe("answer");
    expect(after[1]).toBe(before[1]);
  });

  it("keeps the entry when a listed agent streams without a new message", () => {
    const agents = seed([makeAgent({ id: "a" })]);
    const select = createHistoryLiveSelector(agents);
    const before = select(useSessionStore.getState());

    for (let tick = 0; tick < 100; tick += 1) {
      streamTick(HOST, "a", [
        {
          kind: "thought",
          id: "thought",
          text: `thinking ${tick}`,
          timestamp: RESPONDED_AT,
          status: "loading",
        },
      ]);
      expect(select(useSessionStore.getState())).toBe(before);
    }
  });

  it("follows the turn, the workspace title and the connection of a listed agent", () => {
    const agents = seed([makeAgent({ id: "a", workspaceId: "workspace" })]);
    const select = createHistoryLiveSelector(agents);
    const before = select(useSessionStore.getState());
    expect(before[0]).toMatchObject({ turnPhase: "idle", isWorking: false, clientGeneration: 0 });

    replaceAgent(
      makeAgent({
        id: "a",
        workspaceId: "workspace",
        turn: { phase: "open", turnId: "turn", startedAt: null, cancellationRequestId: null },
      }),
    );
    const running = select(useSessionStore.getState());
    expect(running[0]).toMatchObject({ turnPhase: "open", isWorking: true });

    const workspace = { id: "workspace", name: "main", title: "Renamed" } as WorkspaceDescriptor;
    useSessionStore.getState().setWorkspaces(HOST, new Map([[workspace.id, workspace]]));
    expect(select(useSessionStore.getState())[0].workspaceName).toBe("Renamed");

    useSessionStore.getState().updateSessionClient(HOST, {} as DaemonClient, 3);
    expect(select(useSessionStore.getState())[0].clientGeneration).toBe(3);
  });
});

describe("createHistoryRowsBuilder", () => {
  const idleQuery = {
    data: undefined,
    isPending: true,
    fetchStatus: "idle",
    isError: false,
  } as const;

  it("keeps the rows while nothing a row shows changed", () => {
    const agents = seed([makeAgent({ id: "a" }), makeAgent({ id: "b" })]);
    const live = createHistoryLiveSelector(agents)(useSessionStore.getState());
    const build = createHistoryRowsBuilder();
    const before = build(agents, live, [idleQuery, idleQuery]);

    const again = build(
      agents.map((agent) => ({ ...agent })),
      createHistoryLiveSelector(agents)(useSessionStore.getState()),
      [{ ...idleQuery }, { ...idleQuery }],
    );

    expect(again).toBe(before);
  });

  it("replaces only the row whose summary changed and re-sorts by response time", () => {
    const agents = seed([makeAgent({ id: "a" }), makeAgent({ id: "b" })]);
    const live = createHistoryLiveSelector(agents)(useSessionStore.getState());
    const build = createHistoryRowsBuilder();
    const before = build(agents, live, [idleQuery, idleQuery]);
    expect(before.map((row) => row.agent.id)).toEqual(["a", "b"]);

    const answered = {
      ...idleQuery,
      isPending: false,
      data: { ...EMPTY_CONVERSATION, lastResponseAt: RESPONDED_AT.getTime() },
    };
    const after = build(agents, live, [idleQuery, answered]);

    expect(after.map((row) => row.agent.id)).toEqual(["b", "a"]);
    expect(after[1]).toBe(before[0]);
    expect(after[0]).not.toBe(before[1]);
    expect(after[0].summary.lastResponseAt).toBe(RESPONDED_AT.getTime());
  });
});

describe("useHistoryConversations", () => {
  it("does not render or rebuild rows while agents outside the list stream", () => {
    const agents = seed([
      makeAgent({ id: "a" }),
      makeAgent({ id: "b" }),
      makeAgent({ id: "unlisted" }),
    ]).slice(0, 2);
    const { result, counter } = renderConversations(agents);
    const renders = counter.renders;
    const rows = result.current.rows;

    for (let tick = 0; tick < 100; tick += 1) {
      act(() => {
        streamTick(tick % 2 ? HOST : OTHER_HOST, "unlisted", [assistantMessage(`token ${tick}`)]);
      });
    }

    expect(counter.renders).toBe(renders);
    expect(result.current.rows).toBe(rows);
  });

  it("does not render while a listed agent streams thoughts", () => {
    const agents = seed([makeAgent({ id: "a" }), makeAgent({ id: "b" })]);
    const { result, counter } = renderConversations(agents);
    const renders = counter.renders;
    const rows = result.current.rows;

    for (let tick = 0; tick < 100; tick += 1) {
      act(() => {
        streamTick(HOST, "a", [
          {
            kind: "thought",
            id: "thought",
            text: `thinking ${tick}`,
            timestamp: new Date(RESPONDED_AT.getTime() + tick),
            status: "loading",
          },
        ]);
      });
    }

    expect(counter.renders).toBe(renders);
    expect(result.current.rows).toBe(rows);
  });

  it("follows a listed agent's live reply and rebuilds only its row", () => {
    const agents = seed([makeAgent({ id: "a" }), makeAgent({ id: "b" })]);
    const { result } = renderConversations(agents);
    const untouched = result.current.rows.find((row) => row.agent.id === "b");

    // Each chunk extends the reply and moves its timestamp, as the stream reducer does.
    for (let tick = 0; tick < 50; tick += 1) {
      const at = new Date(RESPONDED_AT.getTime() + tick);
      act(() => streamTick(HOST, "a", [assistantMessage("first words".slice(0, tick + 1), at)]));
      expect(result.current.rows.find((row) => row.agent.id === "b")).toBe(untouched);
    }

    expect(result.current.rows.find((row) => row.agent.id === "a")?.summary).toEqual({
      preview: "first words",
      previewAt: RESPONDED_AT.getTime() + 49,
      lastResponseAt: RESPONDED_AT.getTime() + 49,
      lastRequestAt: REQUESTED_AT.getTime(),
    });
  });

  it("fetches a running conversation once across activity updates and again when it settles", async () => {
    const fetchAgentTimeline = vi.fn(async () => timelinePage("working on it", REQUESTED_AT));
    runtime.client = { fetchAgentTimeline };
    const open = { phase: "open", turnId: "turn", startedAt: null, cancellationRequestId: null };
    const running = (lastActivityAt: Date) =>
      makeAgent({ id: "a", status: "running", turn: open as Agent["turn"], lastActivityAt });
    const { result, rerender } = renderConversations(seed([running(REQUESTED_AT)]));
    await waitFor(() => expect(result.current.rows[0].summary.preview).toBe("working on it"));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(1);

    for (let event = 1; event <= 20; event += 1) {
      const next = running(new Date(REQUESTED_AT.getTime() + event * 1000));
      act(() => {
        replaceAgent(next);
        rerender({ agents: [listed(next)] });
      });
      expect(result.current.rows[0]).toMatchObject({ isWorking: true, isLoading: false });
      expect(result.current.rows[0].summary.preview).toBe("working on it");
    }
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(1);

    fetchAgentTimeline.mockImplementation(async () => timelinePage("all done", RESPONDED_AT));
    const finished = makeAgent({ id: "a", lastActivityAt: RESPONDED_AT });
    act(() => {
      replaceAgent(finished);
      rerender({ agents: [listed(finished)] });
    });
    await waitFor(() =>
      expect(result.current.rows[0].summary.lastResponseAt).toBe(RESPONDED_AT.getTime()),
    );
    expect(result.current.rows[0]).toMatchObject({ isWorking: false });
    expect(result.current.rows[0].summary.preview).toBe("all done");
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);
  });

  it("fetches a turn that resumes without a new request instead of showing the previous run", async () => {
    vi.useFakeTimers();
    const fetchAgentTimeline = vi.fn(async (..._args: unknown[]) =>
      timelinePage("early progress", REQUESTED_AT),
    );
    runtime.client = { fetchAgentTimeline };
    const { result, rerender } = renderConversations(seed([runningAgent()]));
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(result.current.rows[0].summary.preview).toBe("early progress");

    fetchAgentTimeline.mockImplementation(async () => timelinePage("final answer", RESPONDED_AT));
    const finished = makeAgent({ id: "running", lastActivityAt: RESPONDED_AT });
    act(() => {
      replaceAgent(finished);
      rerender({ agents: [listed(finished)] });
    });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(result.current.rows[0].summary.preview).toBe("final answer");
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);

    // A background task resumes the conversation: a new turn, the same last request.
    fetchAgentTimeline.mockImplementation(async () =>
      timelinePage("resumed progress", new Date(RESPONDED_AT.getTime() + MINUTES)),
    );
    const resumed = makeAgent({
      id: "running",
      status: "running",
      turn: { phase: "open", turnId: "resumed", startedAt: null, cancellationRequestId: null },
      lastActivityAt: new Date(RESPONDED_AT.getTime() + MINUTES),
    });
    act(() => {
      replaceAgent(resumed);
      rerender({ agents: [listed(resumed)] });
    });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(3);
    expect(result.current.rows[0]).toMatchObject({ isWorking: true, isLoading: false });
    expect(result.current.rows[0].summary.preview).toBe("resumed progress");
  });

  it("refreshes a running conversation 30 seconds after new activity and leaves a quiet one alone", async () => {
    vi.useFakeTimers();
    const fetchAgentTimeline = vi.fn(async (..._args: unknown[]) =>
      timelinePage("progress", REQUESTED_AT),
    );
    runtime.client = { fetchAgentTimeline };
    const [running, finished] = seed([runningAgent(), makeAgent({ id: "finished" })]);
    const { rerender } = renderConversations([running, finished]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchAgentTimeline.mock.calls.map(([agentId]) => agentId).sort()).toEqual([
      "finished",
      "running",
    ]);

    // A turn that stays open without activity, such as a stuck one, is never polled.
    await act(() => vi.advanceTimersByTimeAsync(10 * MINUTES));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);

    reportActivity(rerender, activityAfter(1), [finished]);
    await act(() => vi.advanceTimersByTimeAsync(29_000));
    reportActivity(rerender, activityAfter(2), [finished]);
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(3);
    expect(fetchAgentTimeline.mock.calls[2][0]).toBe("running");

    await act(() => vi.advanceTimersByTimeAsync(10 * MINUTES));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(3);
  });

  it("reports loading for a running conversation's first fetch but not for its refresh", async () => {
    vi.useFakeTimers();
    const pending: ((page: ReturnType<typeof timelinePage>) => void)[] = [];
    const fetchAgentTimeline = vi.fn(
      () => new Promise<ReturnType<typeof timelinePage>>((resolve) => pending.push(resolve)),
    );
    runtime.client = { fetchAgentTimeline };
    const { result, rerender, counter } = renderConversations(seed([runningAgent()]));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.rows[0].isLoading).toBe(true);

    pending[0](timelinePage("progress", REQUESTED_AT));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.rows[0].summary.preview).toBe("progress");

    const settled = counter.loading.length;
    reportActivity(rerender, activityAfter(1));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);
    // The refresh is in flight. Give its fetch-start notification time to reach the hook.
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(pending).toHaveLength(2);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.rows[0].isLoading).toBe(false);

    pending[1](timelinePage("more progress", RESPONDED_AT));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.rows[0].summary.preview).toBe("more progress");
    expect(counter.loading.slice(settled)).not.toContain(true);
  });

  it("retries a failed refresh of a running conversation only after new activity", async () => {
    vi.useFakeTimers();
    const fetchAgentTimeline = vi.fn(async (..._args: unknown[]) =>
      timelinePage("progress", REQUESTED_AT),
    );
    runtime.client = { fetchAgentTimeline };
    const { result, rerender } = renderConversations(seed([runningAgent()]));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(1);

    fetchAgentTimeline.mockRejectedValue(new Error("daemon busy"));
    reportActivity(rerender, activityAfter(1));
    await act(() => vi.advanceTimersByTimeAsync(40_000));
    // One refresh and its single retry.
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(3);
    expect(result.current.rows[0]).toMatchObject({ isError: true, isLoading: false });
    expect(result.current.rows[0].summary.preview).toBe("progress");

    // The failure is not retried on its own while the turn stays quiet.
    await act(() => vi.advanceTimersByTimeAsync(10 * MINUTES));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(3);

    fetchAgentTimeline.mockImplementation(async () => timelinePage("more progress", RESPONDED_AT));
    reportActivity(rerender, activityAfter(2));
    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(4);
    // A zero-delay timer set inside a fake tick lands 1 ms later; give the result time to land.
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.rows[0]).toMatchObject({ isError: false, isWorking: true });
    expect(result.current.rows[0].summary.preview).toBe("more progress");

    await act(() => vi.advanceTimersByTimeAsync(10 * MINUTES));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(4);
  });

  it("fetches a running conversation whose first fetch failed again only after new activity", async () => {
    vi.useFakeTimers();
    const fetchAgentTimeline = vi.fn(async (..._args: unknown[]): Promise<unknown> => {
      throw new Error("daemon busy");
    });
    runtime.client = { fetchAgentTimeline };
    const { result, rerender } = renderConversations(seed([runningAgent()]));
    await act(() => vi.advanceTimersByTimeAsync(40_000));
    // The first fetch and its single retry.
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.rows[0]).toMatchObject({ isError: true, isLoading: false });
    expect(result.current.rows[0].summary.preview).toBe("");

    await act(() => vi.advanceTimersByTimeAsync(10 * MINUTES));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);

    fetchAgentTimeline.mockImplementation(async () => timelinePage("progress", RESPONDED_AT));
    reportActivity(rerender, activityAfter(1));
    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(result.current.rows[0]).toMatchObject({ isError: false, isLoading: false });
    expect(result.current.rows[0].summary.preview).toBe("progress");

    await act(() => vi.advanceTimersByTimeAsync(10 * MINUTES));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(3);
  });

  it("does not let two lists that know different activity times refresh a conversation in turns", async () => {
    vi.useFakeTimers();
    const fetchAgentTimeline = vi.fn(async (..._args: unknown[]) =>
      timelinePage("progress", REQUESTED_AT),
    );
    runtime.client = { fetchAgentTimeline };
    const cache = createQueryCache();
    const agents = seed([runningAgent()]);
    // The history list keeps the time it fetched; the activity list follows agent_update.
    renderConversations(agents, cache);
    const { rerender } = renderConversations(agents, cache);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(1);

    reportActivity(rerender, activityAfter(1));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);

    await act(() => vi.advanceTimersByTimeAsync(10 * MINUTES));
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);
  });
});
