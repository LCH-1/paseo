import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import { ClaudeAgentClient } from "./agent.js";
import { ClaudeHistorySlicer } from "./history-reader.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { FakeClaudeSdk } from "./test-rewind-claude-sdk.js";

/**
 * A resumed Claude agent reads its transcript when something first needs it, never while the
 * session opens. When the transcript is missing or unreadable the agent opens with an empty
 * timeline, and the daemon log at its default level has to say which, and where it looked.
 */

const SESSION_ID = "history-load-session";

/** Private state the tests below read or drive directly. */
interface ClaudeSessionInternals {
  userMessageIds: string[];
  ensurePersistedHistoryLoaded(reason: "history" | "turn" | "rewind"): Promise<void>;
  rebindConversationSession(sessionId: string): void;
}

function internals(session: AgentSession): ClaudeSessionInternals {
  return session as unknown as ClaudeSessionInternals;
}

function userMessageTexts(events: AgentStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "timeline" && event.item.type === "user_message" ? [event.item.text] : [],
  );
}

interface LogRecord {
  level: number;
  msg: string;
  sessionId?: string;
  historyPath?: string;
  reason?: string;
  durationMs?: number;
  transcriptBytes?: number;
  subagentFiles?: number;
  subagentBytes?: number;
  timelineItems?: number;
  err?: { message?: string };
}

describe("ClaudeAgentSession persisted history load", () => {
  let tempRoot: string;
  let cwd: string;
  let configDir: string;
  let records: LogRecord[];

  function createClient(
    options: {
      queryFactory?: ReturnType<typeof vi.fn>;
      rewindSdk?: FakeClaudeSdk;
    } = {},
  ): ClaudeAgentClient {
    return new ClaudeAgentClient({
      logger: pino({ level: "info" }, { write: (line: string) => records.push(JSON.parse(line)) }),
      queryFactory: (options.queryFactory ??
        vi.fn(() => {
          throw new Error("history load must not start a query");
        })) as never,
      resolveBinary: async () => "/test/claude/bin",
      resolveVersion: async () => "2.1.220",
      ...(options.rewindSdk ? { rewindSdk: options.rewindSdk } : {}),
    });
  }

  async function resume(client = createClient()): Promise<AgentSession> {
    return client.resumeSession({ provider: "claude", sessionId: SESSION_ID }, { cwd });
  }

  async function drainHistory(session: AgentSession): Promise<AgentStreamEvent[]> {
    const events: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) events.push(event);
    return events;
  }

  async function resumeAndReplay(): Promise<AgentStreamEvent[]> {
    const session = await resume();
    try {
      return await drainHistory(session);
    } finally {
      await session.close();
    }
  }

  function transcriptPath(sessionId = SESSION_ID): string {
    return path.join(claudeProjectDirSync(cwd, { configDir }), `${sessionId}.jsonl`);
  }

  function writeTranscript(lines: unknown[], sessionId = SESSION_ID): void {
    const file = transcriptPath(sessionId);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  }

  function historyLogs(): LogRecord[] {
    return records.filter((record) => /history|transcript/i.test(record.msg));
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-history-load-"));
    cwd = path.join(tempRoot, "repo");
    configDir = path.join(tempRoot, "claude-config");
    mkdirSync(cwd, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    records = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("logs the resolved transcript path when the transcript does not exist", async () => {
    await resumeAndReplay();

    expect(records).toContainEqual(
      expect.objectContaining({
        level: pino.levels.values.info,
        msg: "No Claude transcript to load history from",
        sessionId: SESSION_ID,
        historyPath: transcriptPath(),
      }),
    );
  });

  test("logs a warning with the error when the transcript cannot be read", async () => {
    // A directory at the transcript path exists but cannot be read as a file.
    mkdirSync(transcriptPath(), { recursive: true });

    await resumeAndReplay();

    expect(records).toContainEqual(
      expect.objectContaining({
        level: pino.levels.values.warn,
        msg: "Failed to load Claude history from transcript",
        sessionId: SESSION_ID,
        historyPath: transcriptPath(),
        err: expect.objectContaining({ message: expect.stringContaining("EISDIR") }),
      }),
    );
  });

  // chmod does not remove read access on Windows, or for root.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "logs a warning with the error when Claude's project folders cannot be listed",
    async () => {
      // The transcript is not under cwd's folder, so the lookup lists the other project folders.
      mkdirSync(path.join(configDir, "projects"), { recursive: true });
      chmodSync(path.join(configDir, "projects"), 0o000);

      try {
        await resumeAndReplay();
      } finally {
        chmodSync(path.join(configDir, "projects"), 0o755);
      }

      expect(records).toContainEqual(
        expect.objectContaining({
          level: pino.levels.values.warn,
          msg: "Failed to load Claude history from transcript",
          sessionId: SESSION_ID,
          err: expect.objectContaining({ message: expect.stringContaining("EACCES") }),
        }),
      );
    },
  );

  test("does not read the transcript while the session only opens", async () => {
    // Any read of this path fails loudly, so a read at open would leave a warning behind.
    mkdirSync(transcriptPath(), { recursive: true });

    const opened = await resume();
    try {
      // A second session reads the same path on demand. By the time its read has failed, a read
      // the first one started when it opened, earlier and identical, has failed and logged too.
      // Closing the first session sooner would abandon such a read before it could log.
      const reader = await resume();
      try {
        await drainHistory(reader);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        await reader.close();
      }
    } finally {
      await opened.close();
    }

    expect(historyLogs()).toEqual([
      expect.objectContaining({
        level: pino.levels.values.warn,
        msg: "Failed to load Claude history from transcript",
      }),
    ]);
  });

  test("a read superseded by a rebind leaves nothing of the old session behind", async () => {
    writeTranscript([
      {
        type: "user",
        uuid: "first-user",
        timestamp: "2026-11-01T00:00:00.000Z",
        message: { role: "user", content: "first prompt" },
      },
    ]);
    writeTranscript(
      [
        {
          type: "user",
          uuid: "other-user",
          timestamp: "2026-11-01T00:00:00.000Z",
          message: { role: "user", content: "other prompt" },
        },
      ],
      "other-session",
    );
    const session = await resume();

    try {
      // A transcript this small is read without a single pause, the only place a read used to
      // notice it was superseded.
      const reading = internals(session).ensurePersistedHistoryLoaded("history");
      internals(session).rebindConversationSession("other-session");
      await reading;

      expect(userMessageTexts(await drainHistory(session))).toEqual(["other prompt"]);
      expect(internals(session).userMessageIds).toEqual(["other-user"]);
    } finally {
      await session.close();
    }
  });

  test("a read in flight when the session closes stops without applying anything", async () => {
    writeTranscript([
      {
        type: "user",
        uuid: "closed-user",
        timestamp: "2026-11-01T00:00:00.000Z",
        message: { role: "user", content: "prompt of a closed session" },
      },
    ]);
    const session = await resume();

    const reading = internals(session).ensurePersistedHistoryLoaded("history");
    await session.close();
    await reading;

    expect(internals(session).userMessageIds).toEqual([]);
    expect(historyLogs()).toEqual([]);
  });

  test("rewinds a reopened session whose timeline the daemon still holds", async () => {
    writeTranscript([
      {
        type: "user",
        uuid: "history-user-1",
        timestamp: "2026-11-01T00:00:00.000Z",
        message: { role: "user", content: "first" },
      },
      {
        type: "assistant",
        uuid: "history-assistant-1",
        timestamp: "2026-11-01T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "one" }] },
      },
      {
        type: "user",
        uuid: "history-user-2",
        timestamp: "2026-11-01T00:00:02.000Z",
        message: { role: "user", content: "second" },
      },
      {
        type: "assistant",
        uuid: "history-assistant-2",
        timestamp: "2026-11-01T00:00:03.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "two" }] },
      },
    ]);
    const rewindSdk = new FakeClaudeSdk();
    // Neither a replay nor a turn has read the transcript; the rewind has to.
    const session = await resume(createClient({ rewindSdk }));

    try {
      await session.revertConversation?.({ messageId: "history-user-2" });
    } finally {
      await session.close();
    }

    expect(rewindSdk.recordedForks).toEqual([{ upToMessageId: "history-assistant-1" }]);
  });

  test("logs how long the read took and how much it read", async () => {
    writeTranscript([
      {
        type: "user",
        uuid: "history-user",
        timestamp: "2026-11-01T00:00:00.000Z",
        message: { role: "user", content: "summarize the docs" },
      },
      {
        type: "assistant",
        uuid: "history-assistant",
        timestamp: "2026-11-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "task-call", name: "Task", input: {} }],
        },
      },
    ]);
    const subagentDir = path.join(path.dirname(transcriptPath()), SESSION_ID, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    const subagentPath = path.join(subagentDir, "agent-child.jsonl");
    writeFileSync(
      subagentPath,
      `${JSON.stringify({
        type: "assistant",
        isSidechain: true,
        agentId: "child",
        message: { role: "assistant", content: [{ type: "text", text: "child output" }] },
      })}\n`,
    );

    await resumeAndReplay();

    expect(records).toContainEqual(
      expect.objectContaining({
        level: pino.levels.values.info,
        msg: "Loaded Claude history from transcript",
        sessionId: SESSION_ID,
        historyPath: transcriptPath(),
        reason: "history",
        durationMs: expect.any(Number),
        transcriptBytes: statSync(transcriptPath()).size,
        subagentFiles: 1,
        subagentBytes: statSync(subagentPath).size,
        timelineItems: expect.any(Number),
      }),
    );
  });

  test("keeps the event loop turning while a large history replays", async () => {
    // About 15MB of parent transcript and 14MB across 24 subagents, each large enough that
    // replaying it without pauses alone exceeds the bound below.
    writeLargeSession({
      transcriptPath: transcriptPath(),
      subagents: 24,
      turnsPerSubagent: 160,
      parentTurns: 4000,
    });
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
    const session = await resume();
    let events: AgentStreamEvent[];
    try {
      events = await drainHistory(session);
    } finally {
      probing = false;
      // A replay that never let the probe run is one pause from the last tick to now.
      longestPauseMs = Math.max(longestPauseMs, performance.now() - lastTick);
      await session.close();
    }
    const replayMs = performance.now() - startedAt;

    expect(events.length).toBeGreaterThan(10_000);
    // Replaying this history synchronously stalls the loop for the whole replay, and longer on a
    // slower machine. Read in slices, no single pause comes close to that.
    expect(longestPauseMs).toBeLessThan(Math.max(80, replayMs / 3));
  });

  test("keeps the event loop turning while a large workflow replays", async () => {
    // About 16MB: eight workflow children of 10,000 rows each, taking turns in time.
    writeWorkflowSession({
      transcriptPath: transcriptPath(),
      children: 8,
      rowsPerChild: 10_000,
      blocksPerRow: 1,
    });
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
    const session = await resume();
    let events: AgentStreamEvent[];
    try {
      events = await drainHistory(session);
    } finally {
      probing = false;
      longestPauseMs = Math.max(longestPauseMs, performance.now() - lastTick);
      await session.close();
    }
    const replayMs = performance.now() - startedAt;

    expect(events.filter((event) => event.type === "provider_subagent").length).toBeGreaterThan(
      80_000,
    );
    // Sorting the rows in one go held the loop for over a third of this replay, and converting
    // them without a pause for half of it.
    expect(longestPauseMs).toBeLessThan(Math.max(80, replayMs / 8));
  });

  test("may pause between any two subagent events it rebuilds", async () => {
    // One row is converted in one go, but the events made from its blocks need not be.
    writeWorkflowSession({
      transcriptPath: transcriptPath(),
      children: 1,
      rowsPerChild: 1,
      blocksPerRow: 5_000,
    });
    // Every slice runs out at once, so the read pauses wherever it may.
    const due = vi.spyOn(ClaudeHistorySlicer.prototype, "due", "get").mockReturnValue(true);
    const pause = vi.spyOn(ClaudeHistorySlicer.prototype, "pause");
    const session = await resume();
    let pausesWhileReading: number;
    let events: AgentStreamEvent[];
    try {
      await internals(session).ensurePersistedHistoryLoaded("history");
      pausesWhileReading = pause.mock.calls.length;
      events = await drainHistory(session);
    } finally {
      due.mockRestore();
      pause.mockRestore();
      await session.close();
    }

    const subagentEvents = events.filter((event) => event.type === "provider_subagent");
    expect(subagentEvents.length).toBeGreaterThan(5_000);
    expect(pausesWhileReading).toBeGreaterThanOrEqual(subagentEvents.length);
  });

  test("replays a subagent with more rows than one call can take as arguments", async () => {
    writeTranscript([
      {
        type: "assistant",
        uuid: "history-assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "task-call", name: "Task", input: {} }],
        },
      },
    ]);
    const subagentDir = path.join(path.dirname(transcriptPath()), SESSION_ID, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    const blocks = Array.from({ length: 200_000 }, () => ({ type: "text", text: "x" }));
    writeFileSync(
      path.join(subagentDir, "agent-child.jsonl"),
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        agentId: "child",
        message: { role: "assistant", content: blocks },
      }),
    );
    writeFileSync(
      path.join(subagentDir, "agent-child.meta.json"),
      JSON.stringify({ toolUseId: "task-call" }),
    );

    const events = await resumeAndReplay();

    expect(events.filter((event) => event.type === "provider_subagent").length).toBeGreaterThan(
      200_000,
    );
    expect(historyLogs().filter((record) => record.level >= pino.levels.values.warn)).toEqual([]);
  });

  test("a turn started before the history is read continues its task list and rewind order", async () => {
    writeTranscript([
      {
        type: "user",
        uuid: "history-user",
        timestamp: "2026-11-01T00:00:00.000Z",
        message: { role: "user", content: "plan the work" },
      },
      {
        type: "assistant",
        uuid: "history-assistant",
        timestamp: "2026-11-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "history-task-call",
              name: "TaskCreate",
              input: { subject: "history task" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "history-task-result",
        timestamp: "2026-11-01T00:00:02.000Z",
        toolUseResult: { task: { id: "1", subject: "history task" } },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "history-task-call", content: "created" }],
        },
      },
    ]);
    const conversation = createLiveTaskConversation();
    const rewindSdk = new FakeClaudeSdk();
    const session = await resume(
      createClient({ queryFactory: conversation.queryFactory, rewindSdk }),
    );
    const events: AgentStreamEvent[] = [];

    try {
      for await (const event of streamSession(session, "add a task")) events.push(event);
      await session.revertConversation?.({ messageId: conversation.userMessageIds[0]! });
    } finally {
      await session.close();
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: {
          type: "todo",
          items: [
            expect.objectContaining({ id: "1", text: "history task" }),
            expect.objectContaining({ id: "2", text: "live task" }),
          ],
        },
      }),
    );
    // The live turn's rewind target is the history's last answered turn.
    expect(rewindSdk.recordedForks).toEqual([{ upToMessageId: "history-assistant" }]);
  });

  test("keeps a turn's prompt as a rewind candidate when Claude does not echo it", async () => {
    writeTranscript([
      {
        type: "user",
        uuid: "history-user",
        timestamp: "2026-11-01T00:00:00.000Z",
        message: { role: "user", content: "plan the work" },
      },
    ]);
    const conversation = createLiveTaskConversation({ echoPrompt: false });
    const session = await resume(createClient({ queryFactory: conversation.queryFactory }));

    try {
      await drainTurn(session, "add a task");
      expect(internals(session).userMessageIds).toEqual([
        "history-user",
        conversation.userMessageIds[0],
      ]);
    } finally {
      await session.close();
    }
  });

  test("does not replay as history a prompt Claude writes while the transcript is read", async () => {
    writeTranscript([
      {
        type: "user",
        uuid: "history-user",
        timestamp: "2026-11-01T00:00:00.000Z",
        message: { role: "user", content: "plan the work" },
      },
      {
        type: "assistant",
        uuid: "history-assistant",
        timestamp: "2026-11-01T00:00:01.000Z",
        // Long enough that the read is still going when Claude appends to the file.
        message: { role: "assistant", content: [{ type: "text", text: "x".repeat(1_500_000) }] },
      },
    ]);
    const liveRows = (userMessageId: string): string =>
      [
        {
          type: "user",
          uuid: userMessageId,
          timestamp: "2026-11-01T00:01:00.000Z",
          message: { role: "user", content: "add a task" },
        },
        {
          type: "assistant",
          uuid: "live-assistant",
          timestamp: "2026-11-01T00:01:01.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "on it" }] },
        },
      ]
        .map((row) => `${JSON.stringify(row)}\n`)
        .join("");
    // Claude records a prompt in the transcript as soon as it receives it.
    const conversation = createLiveTaskConversation({
      onPrompt: (userMessageId) => appendFileSync(transcriptPath(), liveRows(userMessageId)),
    });
    const session = await resume(createClient({ queryFactory: conversation.queryFactory }));

    try {
      await drainTurn(session, "add a task");
      expect(userMessageTexts(await drainHistory(session))).toEqual(["plan the work"]);
      expect(internals(session).userMessageIds).toEqual([
        "history-user",
        conversation.userMessageIds[0],
      ]);
    } finally {
      await session.close();
    }
  });
});

async function drainTurn(session: AgentSession, prompt: string): Promise<void> {
  for await (const event of streamSession(session, prompt)) {
    if (event.type === "turn_failed") throw new Error(`turn failed: ${JSON.stringify(event)}`);
  }
}

function writeLargeSession(options: {
  transcriptPath: string;
  subagents: number;
  turnsPerSubagent: number;
  parentTurns: number;
}): void {
  const output = "synthetic tool output ".repeat(150);
  const sessionDir = path.join(
    path.dirname(options.transcriptPath),
    path.basename(options.transcriptPath, ".jsonl"),
  );
  const subagentDir = path.join(sessionDir, "subagents");
  mkdirSync(subagentDir, { recursive: true });
  let sequence = 0;
  const turn = (base: Record<string, unknown>): string[] => {
    sequence += 1;
    const callId = `call-${sequence}`;
    return [
      { ...base, type: "user", uuid: `user-${sequence}`, message: { role: "user", content: "go" } },
      {
        ...base,
        type: "assistant",
        uuid: `assistant-${sequence}`,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `step ${sequence}` },
            { type: "tool_use", id: callId, name: "Bash", input: { command: `echo ${sequence}` } },
          ],
        },
      },
      {
        ...base,
        type: "user",
        uuid: `result-${sequence}`,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: callId, content: output }],
        },
      },
    ].map((entry) => JSON.stringify(entry));
  };

  const parentLines: string[] = [];
  for (let index = 0; index < options.subagents; index += 1) {
    const agentId = `child${index}`;
    const taskCallId = `task-call-${index}`;
    parentLines.push(
      JSON.stringify({
        type: "assistant",
        uuid: `task-${index}`,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: taskCallId,
              name: "Task",
              input: { description: `child ${index}` },
            },
          ],
        },
      }),
    );
    const childLines: string[] = [];
    for (let step = 0; step < options.turnsPerSubagent; step += 1) {
      childLines.push(...turn({ isSidechain: true, agentId }));
    }
    writeFileSync(path.join(subagentDir, `agent-${agentId}.jsonl`), childLines.join("\n"));
    writeFileSync(
      path.join(subagentDir, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: "general-purpose", toolUseId: taskCallId }),
    );
  }
  for (let step = 0; step < options.parentTurns; step += 1) parentLines.push(...turn({}));
  writeFileSync(options.transcriptPath, parentLines.join("\n"));
}

/** A transcript whose Workflow run wrote child transcripts whose rows take turns in time. */
function writeWorkflowSession(options: {
  transcriptPath: string;
  children: number;
  rowsPerChild: number;
  blocksPerRow: number;
}): void {
  const runId = "wf_history-load-run";
  const toolUseId = "workflow-call";
  const sessionDir = path.join(
    path.dirname(options.transcriptPath),
    path.basename(options.transcriptPath, ".jsonl"),
  );
  mkdirSync(path.join(sessionDir, "workflows"), { recursive: true });
  writeFileSync(
    options.transcriptPath,
    [
      {
        type: "assistant",
        uuid: "workflow-assistant",
        timestamp: "2026-11-01T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: toolUseId, name: "Workflow", input: {} }],
        },
      },
      {
        type: "user",
        uuid: "workflow-result",
        timestamp: "2026-11-01T00:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: `Workflow launched in background.\nRun ID: ${runId}`,
            },
          ],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  writeFileSync(
    path.join(sessionDir, "workflows", `${runId}.json`),
    JSON.stringify({ runId, summary: "Large workflow", status: "completed" }),
  );
  const childDir = path.join(sessionDir, "subagents", "workflows", runId);
  mkdirSync(childDir, { recursive: true });
  const startedAt = Date.parse("2026-11-01T00:00:02.000Z");
  for (let child = 0; child < options.children; child += 1) {
    const agentId = `workflow-child-${child}`;
    const lines: string[] = [];
    for (let row = 0; row < options.rowsPerChild; row += 1) {
      const blocks = Array.from({ length: options.blocksPerRow }, (_, block) => ({
        type: "text",
        text: `child ${child} row ${row} block ${block}`,
      }));
      lines.push(
        JSON.stringify({
          type: "assistant",
          isSidechain: true,
          agentId,
          timestamp: new Date(startedAt + (row * options.children + child) * 1000).toISOString(),
          message: { role: "assistant", content: blocks },
        }),
      );
    }
    writeFileSync(path.join(childDir, `agent-${agentId}.jsonl`), lines.join("\n"));
  }
}

/** Claude echoes the prompt (unless told not to), creates a task, and answers. */
function createLiveTaskConversation(
  options: { echoPrompt?: boolean; onPrompt?: (userMessageId: string) => void } = {},
): {
  queryFactory: ReturnType<typeof vi.fn>;
  userMessageIds: string[];
} {
  const userMessageIds: string[] = [];
  const queryFactory = vi.fn(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const queued: Array<Record<string, unknown>> = [];
    const waiters: Array<() => void> = [];
    const closedRef = { value: false };
    const wake = () => waiters.shift()?.();
    const enqueue = (message: Record<string, unknown>) => {
      queued.push(message);
      wake();
    };

    void (async () => {
      for await (const sent of prompt) {
        const userMessageId = String((sent as { uuid?: unknown }).uuid);
        userMessageIds.push(userMessageId);
        options.onPrompt?.(userMessageId);
        enqueue({
          type: "system",
          subtype: "init",
          session_id: SESSION_ID,
          permissionMode: "default",
          model: "claude-sonnet-4-6",
        });
        if (options.echoPrompt !== false) {
          enqueue({
            type: "user",
            uuid: userMessageId,
            session_id: SESSION_ID,
            message: { role: "user", content: [{ type: "text", text: "add a task" }] },
          });
        }
        enqueue({
          type: "assistant",
          uuid: "live-assistant",
          session_id: SESSION_ID,
          message: {
            id: "live-assistant",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "live-task-call",
                name: "TaskCreate",
                input: { subject: "live task" },
              },
            ],
          },
        });
        enqueue({
          type: "user",
          uuid: "live-task-result",
          session_id: SESSION_ID,
          toolUseResult: { task: { id: "2", subject: "live task" } },
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "live-task-call", content: "created" }],
          },
        });
        enqueue({
          type: "result",
          subtype: "success",
          uuid: "live-result",
          session_id: SESSION_ID,
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "",
          total_cost_usd: 0,
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
          permission_denials: [],
        });
      }
      closedRef.value = true;
      wake();
    })();

    return {
      next: vi.fn(async () => {
        while (queued.length === 0 && !closedRef.value) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
        if (queued.length === 0) return { done: true, value: undefined };
        return { done: false, value: queued.shift() };
      }),
      interrupt: vi.fn(async () => undefined),
      return: vi.fn(async () => {
        closedRef.value = true;
        wake();
        return undefined;
      }),
      close: vi.fn(() => {
        closedRef.value = true;
        wake();
      }),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      supportedModels: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []),
      rewindFiles: vi.fn(async () => ({ canRewind: true })),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  });
  return { queryFactory, userMessageIds };
}
