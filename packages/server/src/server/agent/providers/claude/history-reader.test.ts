import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ClaudeHistorySlicer, readClaudeJsonlFile } from "./history-reader.js";

/** Never asks for a pause, so any turn of the event loop comes from the read itself. */
class NeverDueSlicer extends ClaudeHistorySlicer {
  override get due(): boolean {
    return false;
  }
}

const CHUNK_BYTES = 256 * 1024;

describe("readClaudeJsonlFile", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-history-reader-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("lets the event loop run while it reads a file, not only when a slice runs out", async () => {
    // Sixteen read chunks. Reading a transcript in one synchronous call stalls the daemon for as
    // long as the file takes to read, however finely the parsing after it is sliced.
    const filePath = path.join(tempRoot, "large.jsonl");
    const line = JSON.stringify({ type: "assistant", text: "x".repeat(1000) });
    const lineCount = Math.ceil((16 * CHUNK_BYTES) / (line.length + 1));
    writeFileSync(filePath, `${`${line}\n`.repeat(lineCount)}`);
    let turns = 0;
    let reading = true;
    const countTurn = (): void => {
      turns += 1;
      if (reading) setImmediate(countTurn);
    };
    setImmediate(countTurn);

    const file = await readClaudeJsonlFile(filePath, new NeverDueSlicer());
    reading = false;

    expect(file.records).toHaveLength(lineCount);
    expect(file.bytes).toBe(statSync(filePath).size);
    expect(turns).toBeGreaterThanOrEqual(8);
  });

  test("reads rows that span chunks the same as splitting the whole file", async () => {
    const filePath = path.join(tempRoot, "boundaries.jsonl");
    // The bytes before the text of {"type":"user","text":"..."}.
    const textOffset = JSON.stringify({ type: "user", text: "" }).length - 2;
    const rows: unknown[] = [
      // Starts a three-byte character on the last byte of the first chunk.
      { type: "user", text: `${"a".repeat(CHUNK_BYTES - 1 - textOffset)}한글` },
      // A row longer than three chunks.
      { type: "assistant", text: "b".repeat(3 * CHUNK_BYTES) },
      { type: "user", text: "after the long row" },
    ];
    const content = [
      ...rows.map((row) => JSON.stringify(row)),
      "{not json",
      "[1, 2]",
      "",
      JSON.stringify({ type: "user", text: "crlf" }),
    ].join("\r\n");
    // The last row has no trailing newline.
    writeFileSync(filePath, `${content}\n${JSON.stringify({ type: "user", text: "last" })}`);

    const file = await readClaudeJsonlFile(filePath, new ClaudeHistorySlicer());

    expect(file.records).toEqual([
      ...rows,
      { type: "user", text: "crlf" },
      { type: "user", text: "last" },
    ]);
    expect(file.bytes).toBe(statSync(filePath).size);
  });
});
