import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { asInternals } from "../../test-utils/class-mocks.js";
import type { AgentSessionConfig, AgentStreamEvent } from "../agent-sdk-types.js";
import { CodexAppServerAgentClient, CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import { CodexHistorySlicer } from "./codex/rollout-history.js";
import { createFakeCodexAppServer } from "./codex/test-utils/fake-app-server.js";
import {
  fixtureRolloutPath,
  recordedThreadTurns,
  ROLLOUT_FIXTURE_THREADS,
  RolloutBuilder,
  writeCodexRolloutFixture,
  type RolloutFixture,
} from "./codex/test-utils/rollout-fixture.js";

/**
 * Reading a closed Codex agent used to start `codex app-server` only to ask it for the thread,
 * and converted the whole answer without letting the event loop turn. History is now read from
 * the rollout files, and only a thread they cannot describe goes through app-server. Both routes
 * must hand AgentManager the same rows, sub-agents and rewind points.
 */

const FIXTURE_CWD = "C:\\fixture\\repo";

let codexHome: string;
let emptyCodexHome: string;
let fixture: RolloutFixture;

beforeEach(() => {
  codexHome = mkdtempSync(path.join(tmpdir(), "paseo-codex-rollout-"));
  emptyCodexHome = mkdtempSync(path.join(tmpdir(), "paseo-codex-empty-"));
  fixture = writeCodexRolloutFixture(codexHome);
});

afterEach(() => {
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(emptyCodexHome, { recursive: true, force: true });
});

function config(): AgentSessionConfig {
  return { provider: "codex", cwd: FIXTURE_CWD, modeId: "auto", model: "gpt-5.4" };
}

interface SessionInternals {
  codexUserMessageTurns(): {
    resolve(messageId: string): { index: number; turnId: string | null } | null;
  };
  latestKnownRootTurn: { threadId: string; turnId: string } | null;
  subAgentCallIdByChildThreadId: Map<string, string>;
}

interface RewindPoint {
  messageId: string;
  point: unknown;
}

interface HistoryRead {
  events: AgentStreamEvent[];
  rewindPoints: RewindPoint[];
  latestTurn: unknown;
  subAgentRoutes: Array<[string, string]>;
  appServers: number;
  threadReads: string[];
}

interface ThreadReadServer {
  threadReads: string[];
  appServers(): number;
  spawn(): Promise<ReturnType<typeof createFakeCodexAppServer>["child"]>;
  /** Answers every later `thread/read` with `answer`; throwing makes it an error response. */
  answerReads(answer: (threadId: string) => unknown): void;
}

/** App-server stand-ins that answer `thread/read` as Codex 0.167 did for the fixture. */
function threadReadServer(answers: Record<string, unknown[]> = {}): ThreadReadServer {
  const threadReads: string[] = [];
  let started = 0;
  let answerRead = (id: string): unknown => ({
    thread: { id, turns: answers[id] ?? recordedThreadTurns(id) },
  });
  return {
    threadReads,
    appServers: () => started,
    answerReads: (answer) => {
      answerRead = answer;
    },
    spawn: async () => {
      started += 1;
      return createFakeCodexAppServer({
        "thread/read": async (params) => {
          const id = String((params as { threadId?: unknown }).threadId);
          threadReads.push(id);
          return answerRead(id);
        },
      }).child;
    },
  };
}

function historySession(threadId: string, home: string, server: ThreadReadServer) {
  return new CodexAppServerAgentSession(
    config(),
    { sessionId: threadId, metadata: { cwd: FIXTURE_CWD, model: "gpt-5.4" } },
    createTestLogger(),
    server.spawn,
    { codexHome: home },
    false,
    false,
    false,
    undefined,
    "history",
  );
}

/** Opens `threadId` for history the way AgentManager reads a closed agent. */
async function readHistory(
  threadId: string,
  home: string,
  answers?: Record<string, unknown[]>,
): Promise<HistoryRead> {
  const server = threadReadServer(answers);
  const session = historySession(threadId, home, server);
  try {
    await session.connect();
    const events: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) events.push(event);
    const internals = asInternals<SessionInternals>(session);
    const rewindPoints = events.flatMap((event): RewindPoint[] => {
      if (event.type !== "timeline" || event.item.type !== "user_message") return [];
      const messageId = event.item.messageId;
      if (!messageId) return [];
      return [{ messageId, point: internals.codexUserMessageTurns().resolve(messageId) }];
    });
    return {
      events,
      rewindPoints,
      latestTurn: internals.latestKnownRootTurn,
      subAgentRoutes: Array.from(internals.subAgentCallIdByChildThreadId.entries()),
      appServers: server.appServers(),
      threadReads: server.threadReads,
    };
  } finally {
    await session.close();
  }
}

/** Leaves every later `thread/read` to `server` unanswered; resolves once one is asked. */
function leaveReadsUnanswered(server: ThreadReadServer): Promise<void> {
  return new Promise((resolve) => {
    server.answerReads(() => {
      resolve();
      return new Promise(() => {});
    });
  });
}

interface OpenThread {
  open: { close(): Promise<void> };
  /** Reads the thread's history as AgentManager reads a closed agent of the same provider. */
  readHistory(): Promise<AgentStreamEvent[]>;
}

/** A provider client whose interactive session already has `threadId` open on `server`. */
async function openThreadElsewhere(
  threadId: string,
  server: ThreadReadServer,
): Promise<OpenThread> {
  const provider = new CodexAppServerAgentClient(createTestLogger());
  const internals = asInternals<{
    goalsEnabledPromise: Promise<boolean> | null;
    autoReviewEnabledPromise: Promise<boolean> | null;
    spawnAppServer: ThreadReadServer["spawn"];
  }>(provider);
  internals.goalsEnabledPromise = Promise.resolve(false);
  internals.autoReviewEnabledPromise = Promise.resolve(false);
  internals.spawnAppServer = server.spawn;
  const launch = { env: { CODEX_HOME: codexHome } };
  const handle = { sessionId: threadId, metadata: { cwd: FIXTURE_CWD, model: "gpt-5.4" } };
  const open = await provider.resumeSession(handle, undefined, launch);
  server.threadReads.length = 0;
  return {
    open,
    readHistory: async () => {
      const history = await provider.resumeSession(handle, undefined, launch, {
        purpose: "history",
      });
      try {
        const events: AgentStreamEvent[] = [];
        for await (const event of history.streamHistory()) events.push(event);
        return events;
      } finally {
        await history.close();
      }
    },
  };
}

const FIXTURE_THREADS = [
  "root",
  "child",
  "grandchild",
  "fork",
  "midFork",
  "compressed",
  "live",
] as const;

describe("Codex closed-thread history", () => {
  test.each(FIXTURE_THREADS)(
    "replays the %s thread from its rollout as app-server would, without starting one",
    async (name) => {
      if (name === "compressed" && !fixture.compressed) return;
      const threadId = fixture.threads[name];

      const fromRollout = await readHistory(threadId, codexHome);
      const fromAppServer = await readHistory(threadId, emptyCodexHome);

      expect(fromRollout.appServers).toBe(0);
      expect(fromAppServer.appServers).toBe(1);
      expect(fromAppServer.threadReads[0]).toBe(threadId);
      expect(fromRollout.events.length).toBeGreaterThan(0);
      expect(fromRollout.events).toEqual(fromAppServer.events);
      expect(fromRollout.rewindPoints).toEqual(fromAppServer.rewindPoints);
      expect(fromRollout.latestTurn).toEqual(fromAppServer.latestTurn);
      expect(fromRollout.subAgentRoutes).toEqual(fromAppServer.subAgentRoutes);
    },
  );

  test("reads the sub-agents of a thread from their own rollouts", async () => {
    const fromRollout = await readHistory(ROLLOUT_FIXTURE_THREADS.root, codexHome);
    const fromAppServer = await readHistory(ROLLOUT_FIXTURE_THREADS.root, emptyCodexHome);

    expect(fromAppServer.threadReads).toEqual([
      ROLLOUT_FIXTURE_THREADS.root,
      ROLLOUT_FIXTURE_THREADS.child,
      ROLLOUT_FIXTURE_THREADS.grandchild,
    ]);
    expect(fromRollout.subAgentRoutes.map(([childThreadId]) => childThreadId)).toEqual([
      ROLLOUT_FIXTURE_THREADS.child,
      ROLLOUT_FIXTURE_THREADS.grandchild,
    ]);
  });

  test("asks app-server for a thread whose rollout it cannot read", async () => {
    const threadId = "01a20000-0000-7000-8000-00000000f00d";
    const builder = new RolloutBuilder(0, 0x01a200000000).line("session_meta", {
      session_id: threadId,
      id: threadId,
      timestamp: "2026-11-01T00:00:00.000Z",
      cwd: FIXTURE_CWD,
      originator: "paseo_fixture",
      cli_version: "0.200.0",
      model_provider: "openai",
      base_instructions: null,
      history_mode: "paginated",
    });
    builder.event({ type: "turn_rewound", turn_id: "turn-1" });
    const file = fixtureRolloutPath(codexHome, threadId);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, builder.text());
    const answer = [
      {
        id: "turn-from-app-server",
        items: [
          {
            type: "userMessage",
            id: "item-app",
            content: [{ type: "text", text: "via app-server" }],
          },
        ],
      },
    ];

    const result = await readHistory(threadId, codexHome, { [threadId]: answer });

    expect(result.appServers).toBe(1);
    expect(result.threadReads).toEqual([threadId]);
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({ type: "user_message", text: "via app-server" }),
      }),
    ]);
  });

  test("reads through the app-server that already has the thread open", async () => {
    const threadId = ROLLOUT_FIXTURE_THREADS.root;
    const server = threadReadServer();
    const elsewhere = await openThreadElsewhere(threadId, server);
    try {
      const events = await elsewhere.readHistory();

      expect(server.appServers()).toBe(1);
      expect(server.threadReads[0]).toBe(threadId);
      expect(events.length).toBeGreaterThan(0);
    } finally {
      await elsewhere.open.close();
    }
  });

  test("reads the rollout when the app-server that has the thread open refuses", async () => {
    const threadId = ROLLOUT_FIXTURE_THREADS.root;
    const expected = (await readHistory(threadId, codexHome)).events;
    const server = threadReadServer();
    const elsewhere = await openThreadElsewhere(threadId, server);
    try {
      server.answerReads(() => {
        throw new Error("thread/read failed");
      });

      const events = await elsewhere.readHistory();

      expect(server.threadReads).toEqual([threadId]);
      expect(server.appServers()).toBe(1);
      expect(events).toEqual(expected);
    } finally {
      await elsewhere.open.close();
    }
  });

  test("reads the rollout when the session that has the thread open closes meanwhile", async () => {
    const threadId = ROLLOUT_FIXTURE_THREADS.root;
    const expected = (await readHistory(threadId, codexHome)).events;
    const server = threadReadServer();
    const elsewhere = await openThreadElsewhere(threadId, server);
    const asked = leaveReadsUnanswered(server);

    const reading = elsewhere.readHistory();
    await asked;
    await elsewhere.open.close();

    expect(await reading).toEqual(expected);
    expect(server.appServers()).toBe(1);
  });

  test("stops waiting for an app-server that has the thread open but never answers", async () => {
    const threadId = ROLLOUT_FIXTURE_THREADS.root;
    const expected = (await readHistory(threadId, codexHome)).events;
    const server = threadReadServer();
    const elsewhere = await openThreadElsewhere(threadId, server);
    const asked = leaveReadsUnanswered(server);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const reading = elsewhere.readHistory();
      await asked;
      // Paseo gives an open app-server 15 seconds; other requests wait up to 14 days.
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await reading).toEqual(expected);
      expect(server.appServers()).toBe(1);
    } finally {
      vi.useRealTimers();
      await elsewhere.open.close();
    }
  });

  test("keeps the rewind order of reread history when a message arrives meanwhile", async () => {
    const threadId = ROLLOUT_FIXTURE_THREADS.root;
    const session = historySession(threadId, codexHome, threadReadServer());
    const internals = asInternals<
      SessionInternals & {
        currentThreadId: string | null;
        persistedHistory: Array<{ item: { type: string; messageId?: string } }>;
        loadThreadHistory(
          readThread: (threadId: string) => Promise<unknown>,
          slicer: CodexHistorySlicer,
        ): Promise<void>;
        rememberCodexUserMessageTurn(messageId: string, providerTurnId?: string | null): boolean;
      }
    >(session);
    internals.currentThreadId = threadId;
    let arrivals = 0;
    // Every pause lets a live user_message notification in, as a reconnect's reread allows.
    class EveryPauseSlicer extends CodexHistorySlicer {
      override get due(): boolean {
        return true;
      }

      override async pause(): Promise<void> {
        await super.pause();
        arrivals += 1;
        internals.rememberCodexUserMessageTurn(`live-${arrivals}`, "turn-live");
      }
    }

    await internals.loadThreadHistory(
      async (id) => ({ thread: { id, turns: recordedThreadTurns(id) } }),
      new EveryPauseSlicer(),
    );

    const messageIds = internals.persistedHistory.flatMap((entry) =>
      entry.item.type === "user_message" && entry.item.messageId ? [entry.item.messageId] : [],
    );
    expect(messageIds.length).toBeGreaterThan(1);
    expect(arrivals).toBeGreaterThan(messageIds.length);
    expect(
      messageIds.map((messageId) => internals.codexUserMessageTurns().resolve(messageId)?.index),
    ).toEqual(messageIds.map((_messageId, index) => index));
  });
});

describe("Codex closed-thread history pacing", () => {
  const threadId = "01a30000-0000-7000-8000-0000000000aa";

  /** About 15MB: 3,000 turns of eight items, mostly command output. */
  function writeLongRollout(): void {
    const builder = new RolloutBuilder(0, 0x01a300000000);
    builder.line("session_meta", {
      session_id: threadId,
      id: threadId,
      timestamp: "2026-11-02T00:00:00.000Z",
      cwd: FIXTURE_CWD,
      originator: "paseo_fixture",
      cli_version: "0.167.0",
      model_provider: "openai",
      base_instructions: null,
      history_mode: "paginated",
    });
    const output = "x".repeat(600);
    for (let index = 0; index < 3000; index += 1) {
      const turnId = `turn-${index}`;
      builder.turnStarted(turnId);
      builder.item(threadId, turnId, {
        type: "UserMessage",
        id: `user-${index}`,
        content: [{ type: "text", text: `question ${index}`, text_elements: [] }],
      });
      builder.item(threadId, turnId, {
        type: "Reasoning",
        id: `reasoning-${index}`,
        summary_text: ["thinking"],
        raw_content: [],
      });
      for (let call = 0; call < 5; call += 1) {
        builder.item(threadId, turnId, {
          type: "CommandExecution",
          id: `call-${index}-${call}`,
          command: ["bash", "-lc", `cat file-${call}.txt`],
          cwd: "file:///C:/fixture/repo",
          parsed_cmd: [{ type: "unknown", cmd: `cat file-${call}.txt` }],
          source: "unified_exec_startup",
          status: "completed",
          aggregated_output: output,
          exit_code: 0,
          duration: { secs: 0, nanos: 1_000_000 },
        });
      }
      builder.item(threadId, turnId, {
        type: "AgentMessage",
        id: `answer-${index}`,
        content: [{ type: "Text", text: `answer ${index}` }],
        phase: "final_answer",
      });
      builder.turnComplete(turnId);
    }
    const rolloutPath = fixtureRolloutPath(codexHome, threadId);
    mkdirSync(path.dirname(rolloutPath), { recursive: true });
    writeFileSync(rolloutPath, builder.text());
  }

  interface Paced<T> {
    result: T;
    longestPauseMs: number;
    elapsedMs: number;
  }

  /** Runs `work` while measuring the longest stretch the event loop could not turn. */
  async function measurePauses<T>(work: () => Promise<T>): Promise<Paced<T>> {
    let longestPauseMs = 0;
    let probing = true;
    let lastTick = performance.now();
    const probe = (): void => {
      const now = performance.now();
      longestPauseMs = Math.max(longestPauseMs, now - lastTick);
      lastTick = now;
      if (probing) setImmediate(probe);
    };
    const startedAt = performance.now();
    setImmediate(probe);
    let result: T;
    try {
      result = await work();
    } finally {
      probing = false;
      // Work that never let the probe run is one pause from the last tick to now.
      longestPauseMs = Math.max(longestPauseMs, performance.now() - lastTick);
    }
    return { result, longestPauseMs, elapsedMs: performance.now() - startedAt };
  }

  test("keeps the event loop turning while a long rollout replays", async () => {
    writeLongRollout();

    const paced = await measurePauses(() => readHistory(threadId, codexHome));

    expect(paced.result.appServers).toBe(0);
    expect(paced.result.events.length).toBeGreaterThan(20_000);
    // Converting this history in one go holds the loop for the whole replay. In slices, no pause
    // comes close to that.
    expect(paced.longestPauseMs).toBeLessThan(Math.max(80, paced.elapsedMs / 4));
  });

  test("may pause between any two history events it hands over", async () => {
    writeLongRollout();
    const session = historySession(threadId, codexHome, threadReadServer());
    try {
      await session.connect();
      // AgentManager limits and projects each event before asking for the next one.
      const paced = await measurePauses(async () => {
        let events = 0;
        for await (const _event of session.streamHistory()) {
          const busyUntil = performance.now() + 0.02;
          while (performance.now() < busyUntil);
          events += 1;
        }
        return events;
      });

      expect(paced.result).toBeGreaterThan(20_000);
      expect(paced.longestPauseMs).toBeLessThan(Math.max(80, paced.elapsedMs / 4));
    } finally {
      await session.close();
    }
  });
});
