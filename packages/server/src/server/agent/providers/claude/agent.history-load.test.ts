import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { FakeClaudeSdk } from "./test-rewind-claude-sdk.js";

/**
 * A resumed Claude agent reads its transcript when something first needs it, never while the
 * session opens. When the transcript is missing or unreadable the agent opens with an empty
 * timeline, and the daemon log at its default level has to say which, and where it looked.
 */

const SESSION_ID = "history-load-session";

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

  function transcriptPath(): string {
    return path.join(claudeProjectDirSync(cwd, { configDir }), `${SESSION_ID}.jsonl`);
  }

  function writeTranscript(lines: unknown[]): void {
    mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    writeFileSync(transcriptPath(), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
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

    const session = await resume();
    await session.close();

    expect(historyLogs()).toEqual([]);
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
});

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

/** Claude echoes the prompt, creates a task, and answers. */
function createLiveTaskConversation(): {
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
        enqueue({
          type: "system",
          subtype: "init",
          session_id: SESSION_ID,
          permissionMode: "default",
          model: "claude-sonnet-4-6",
        });
        enqueue({
          type: "user",
          uuid: userMessageId,
          session_id: SESSION_ID,
          message: { role: "user", content: [{ type: "text", text: "add a task" }] },
        });
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
