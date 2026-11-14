import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type {
  Options,
  Query,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import * as spawnUtils from "../../../../utils/spawn.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

// The phases are timed on performance.now(); each test moves this clock inside the step it
// makes slow, so a phase's milliseconds are exactly what the test spent in it.
let clock = 0;

interface CapturedLine {
  msg: string;
  [field: string]: unknown;
}

function createCapturingLogger(): { logger: pino.Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const logger = pino(
    { level: "info" },
    {
      write(line: string) {
        lines.push(JSON.parse(line));
      },
    },
  );
  return { logger, lines };
}

function launchLines(lines: CapturedLine[]): CapturedLine[] {
  return lines.filter((line) => line.msg === "Claude query launch slow");
}

interface QueryMockOptions {
  onReturn?: () => void;
  /** Runs inside applyFlagSettings; whatever it throws is what the process answers. */
  onFlagSettings?: () => void;
}

// Stays open after its turn, as a real query does, until the session retires it.
function createQueryMock(options: QueryMockOptions = {}): Query {
  const events: unknown[] = [
    {
      type: "system",
      subtype: "init",
      session_id: "claude-query-launch-session",
      permissionMode: "default",
      model: "opus",
    },
    { type: "assistant", message: { content: "DONE" } },
    {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      total_cost_usd: 0,
    },
  ];
  let index = 0;
  return {
    next: vi.fn(async () => {
      if (index < events.length) return { done: false, value: events[index++] };
      return new Promise<never>(() => undefined);
    }),
    return: vi.fn(async () => {
      options.onReturn?.();
      return { done: true, value: undefined };
    }),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    applyFlagSettings: vi.fn(async () => {
      options.onFlagSettings?.();
    }),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as unknown as Query;
}

function createChildProcessStub(onKill: () => void): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.kill = ((signal?: NodeJS.Signals | number) => {
    onKill();
    child.emit("exit", null, typeof signal === "string" ? signal : "SIGTERM");
    return true;
  }) as ChildProcess["kill"];
  return child;
}

const SPAWN_OPTIONS: ClaudeSpawnOptions = {
  command: "node",
  args: ["claude.js"],
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
};

const PROMPT = "rewrite the payroll export";

describe("Claude query launch timing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clock = 0;
  });

  test("logs the phases of a relaunch after a settings change that took over 500ms", async () => {
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { logger, lines } = createCapturingLogger();
    let capturedOptions: Options | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedOptions = options;
      return createQueryMock({ onReturn: () => (clock += 700) });
    });
    vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(
      createChildProcessStub(() => (clock += 900)),
    );
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession(
      { provider: "claude", cwd: process.cwd() },
      { agentId: "agent-claude-1" },
    );

    try {
      await session.run(PROMPT);
      capturedOptions?.spawnClaudeCodeProcess?.(SPAWN_OPTIONS);
      // The first launch spent no time on the clock, so it stays out of the log.
      expect(launchLines(lines)).toEqual([]);

      await session.setThinkingOption?.(null);
      await session.listCommands?.();

      const launches = launchLines(lines);
      expect(launches).toEqual([
        expect.objectContaining({
          level: 30,
          module: "agent",
          provider: "claude",
          agentId: "agent-claude-1",
          restart: true,
          ok: true,
          endInputMs: 0,
          returnMs: 700,
          treeKillMs: 900,
          buildOptionsMs: 0,
          startQueryMs: 0,
          totalMs: 1_600,
        }),
      ]);
      expect(launches[0]).not.toHaveProperty("flagSettingsMs");
      const written = JSON.stringify(launches);
      expect(written).not.toContain(PROMPT);
      expect(written).not.toContain(process.cwd());
    } finally {
      await session.close();
    }
  });

  test("logs a first launch that waited over 500ms for the process to take its flag settings", async () => {
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { logger, lines } = createCapturingLogger();
    const queryFactory = vi.fn(() =>
      createQueryMock({
        onFlagSettings: () => {
          clock += 1_840;
        },
      }),
    );
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-opus-5-5",
    });

    try {
      await session.run(PROMPT);

      expect(launchLines(lines)).toEqual([
        expect.objectContaining({
          restart: false,
          ok: true,
          buildOptionsMs: 0,
          startQueryMs: 0,
          flagSettingsMs: 1_840,
          totalMs: 1_840,
        }),
      ]);
      expect(launchLines(lines)[0]).not.toHaveProperty("returnMs");
    } finally {
      await session.close();
    }
  });

  test("logs a launch that failed after 500ms as not ok, without the phase it failed in", async () => {
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { logger, lines } = createCapturingLogger();
    const queryFactory = vi.fn(() =>
      createQueryMock({
        onFlagSettings: () => {
          clock += 800;
          throw new Error(`Claude exited while taking flag settings for ${process.cwd()}`);
        },
      }),
    );
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-opus-5-5",
    });

    try {
      await expect(session.listCommands?.()).rejects.toThrow("flag settings");

      const launches = launchLines(lines);
      expect(launches).toEqual([
        expect.objectContaining({
          level: 30,
          restart: false,
          ok: false,
          buildOptionsMs: 0,
          startQueryMs: 0,
          totalMs: 800,
        }),
      ]);
      expect(launches[0]).not.toHaveProperty("flagSettingsMs");
      // The error, which names the directory, stays out of the line.
      const written = JSON.stringify(launches);
      expect(written).not.toContain("flag settings");
      expect(written).not.toContain(JSON.stringify(process.cwd()).slice(1, -1));
    } finally {
      await session.close();
    }
  });
});
