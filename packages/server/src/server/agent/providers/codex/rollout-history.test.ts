import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  CodexHistorySlicer,
  CodexRolloutUnavailableError,
  readCodexThreadFromRollouts,
} from "./rollout-history.js";
import { CodexRolloutFormatError } from "./rollout-thread-item.js";
import {
  fixtureRolloutPath,
  recordedThreadTurns,
  RolloutBuilder,
  writeCodexRolloutFixture,
  type RolloutFixture,
} from "./test-utils/rollout-fixture.js";

/**
 * Paseo reads closed Codex threads from their rollout files instead of asking `codex app-server`.
 * The fixture's recorded `thread/read` answers come from Codex 0.167.0 itself, so equality here
 * is equality with app-server.
 */

let codexHome: string;
let fixture: RolloutFixture;

beforeEach(() => {
  codexHome = mkdtempSync(path.join(tmpdir(), "paseo-codex-rollout-"));
  fixture = writeCodexRolloutFixture(codexHome);
});

afterEach(() => {
  rmSync(codexHome, { recursive: true, force: true });
});

function read(threadId: string) {
  return readCodexThreadFromRollouts({ codexHome, threadId, slicer: new CodexHistorySlicer() });
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

describe("Codex rollout history", () => {
  test.each(FIXTURE_THREADS)(
    "rebuilds the %s thread exactly as Codex app-server returns it",
    async (name) => {
      if (name === "compressed" && !fixture.compressed) return;
      const threadId = fixture.threads[name];

      const result = await read(threadId);

      expect(JSON.parse(JSON.stringify(result.thread.turns))).toEqual(
        recordedThreadTurns(threadId),
      );
    },
  );
});

describe("Codex rollout history refuses what it cannot place", () => {
  const threadId = "01a20000-0000-7000-8000-00000000f00d";

  function meta(extra: Record<string, unknown> = {}) {
    return {
      session_id: threadId,
      id: threadId,
      timestamp: "2026-11-01T00:00:00.000Z",
      cwd: "C:\\fixture\\repo",
      originator: "paseo_fixture",
      cli_version: "0.200.0",
      model_provider: "openai",
      base_instructions: null,
      history_mode: "paginated",
      ...extra,
    };
  }

  function rollout(extra: Record<string, unknown> = {}): RolloutBuilder {
    const builder = new RolloutBuilder(0, 0x01a200000000).line("session_meta", meta(extra));
    builder.turnStarted("turn-1");
    builder.item(threadId, "turn-1", {
      type: "UserMessage",
      id: "item-user",
      content: [{ type: "text", text: "hello", text_elements: [] }],
    });
    return builder.turnComplete("turn-1");
  }

  function write(builder: RolloutBuilder, file = fixtureRolloutPath(codexHome, threadId)): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, builder.text());
  }

  test("reads a rollout written by a newer Codex when every record is known", async () => {
    write(rollout());

    const result = await read(threadId);

    expect(result.thread.turns).toHaveLength(1);
  });

  test.each([
    ["an event a newer Codex added", () => rollout().event({ type: "turn_rewound" })],
    [
      "an item type a newer Codex added",
      () => rollout().item(threadId, "turn-1", { type: "Hologram", id: "item-new" }),
    ],
    ["a record type a newer Codex added", () => rollout().line("timeline_marker", {})],
  ])("refuses %s", async (_name, build) => {
    write(build());

    await expect(read(threadId)).rejects.toBeInstanceOf(CodexRolloutFormatError);
  });

  test.each([
    ["a legacy rollout", () => write(rollout({ history_mode: "legacy" }))],
    ["an attached thread", () => write(rollout({ attached_thread: true }))],
    [
      "a reverted thread",
      () => {
        write(rollout());
        write(
          rollout(),
          fixtureRolloutPath(codexHome, threadId).replace(
            `-${threadId}.jsonl`,
            `-${threadId}_01a20000-0001-7000-8000-00000000beef.jsonl`,
          ),
        );
      },
    ],
    ["a missing rollout", () => {}],
    [
      "a fork whose parent is gone",
      () =>
        write(
          rollout({
            history_base: {
              thread_id: "01a10000-0000-7000-8000-00000000dead",
              end_ordinal_exclusive: 3,
              end_byte_offset: 100,
            },
          }),
        ),
    ],
  ])("leaves %s to app-server", async (_name, setup) => {
    setup();

    await expect(read(threadId)).rejects.toBeInstanceOf(CodexRolloutUnavailableError);
  });
});

describe("Codex rollout history skips model context unparsed", () => {
  const threadId = "01a50000-0000-7000-8000-0000000000cc";
  const READ_CHUNK_BYTES = 256 * 1024;

  /** One turn among model-context lines; `fillerBytes` moves where the 1MB line starts. */
  function build(fillerBytes: number) {
    const builder = new RolloutBuilder(0, 0x01a500000000).line("session_meta", {
      session_id: threadId,
      id: threadId,
      timestamp: "2026-11-04T00:00:00.000Z",
      cwd: "C:\\fixture\\repo",
      originator: "paseo_fixture",
      cli_version: "0.167.0",
      model_provider: "openai",
      base_instructions: null,
      history_mode: "paginated",
    });
    builder.turnStarted("turn-1");
    builder.line("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "f".repeat(fillerBytes) }],
    });
    const largeLineStart = builder.byteLength;
    builder.line("response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "m".repeat(1_000_000) }],
    });
    builder.item(threadId, "turn-1", {
      type: "UserMessage",
      id: "user-1",
      content: [{ type: "text", text: "hello", text_elements: [] }],
    });
    builder.turnComplete("turn-1");
    return { builder, largeLineStart };
  }

  test.each([1, 60])(
    "does not parse a large line that starts %d bytes before a read chunk ends",
    async (bytesBeforeChunkEnd) => {
      const unpadded = build(0).largeLineStart;
      const target =
        Math.ceil((unpadded + bytesBeforeChunkEnd) / READ_CHUNK_BYTES) * READ_CHUNK_BYTES -
        bytesBeforeChunkEnd;
      const { builder, largeLineStart } = build(target - unpadded);
      expect(largeLineStart % READ_CHUNK_BYTES).toBe(READ_CHUNK_BYTES - bytesBeforeChunkEnd);
      const file = fixtureRolloutPath(codexHome, threadId);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, builder.text());

      const parsedLengths: number[] = [];
      const parse = vi.spyOn(JSON, "parse");
      let result: Awaited<ReturnType<typeof read>>;
      try {
        result = await read(threadId);
      } finally {
        parsedLengths.push(...parse.mock.calls.map(([text]) => String(text).length));
        parse.mockRestore();
      }

      expect(result.thread.turns).toHaveLength(1);
      expect(result.thread.turns[0]?.items).toEqual([
        expect.objectContaining({ type: "userMessage", id: "user-1" }),
      ]);
      expect(Math.max(0, ...parsedLengths)).toBeLessThan(100_000);
    },
  );
});
