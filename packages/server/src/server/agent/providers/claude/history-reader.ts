import { createReadStream, type Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";

import { parseClaudeSubagentMeta, type ClaudeSubagentMeta } from "./subagents/replay-source.js";

/**
 * A session's transcript and subagent transcripts can reach hundreds of megabytes. Reading and
 * replaying them in one synchronous pass stalled every agent stream, terminal and request on the
 * daemon for seconds, so the work runs in slices of this length with the event loop in between.
 */
const HISTORY_SLICE_MS = 8;
const TRANSCRIPT_READ_CHUNK_BYTES = 256 * 1024;

/** Thrown at a slice boundary when the load it belongs to was superseded or its session closed. */
export class ClaudeHistoryLoadAbandonedError extends Error {
  constructor() {
    super("Claude history load was superseded");
    this.name = "ClaudeHistoryLoadAbandonedError";
  }
}

export class ClaudeHistorySlicer {
  private sliceStartedAt = performance.now();

  constructor(private readonly isCurrent: () => boolean = () => true) {}

  /** Cheap enough to check once per entry. */
  get due(): boolean {
    return performance.now() - this.sliceStartedAt >= HISTORY_SLICE_MS;
  }

  async pause(): Promise<void> {
    await waitForImmediate();
    if (!this.isCurrent()) throw new ClaudeHistoryLoadAbandonedError();
    this.sliceStartedAt = performance.now();
  }

  /** Runs replay steps to completion, pausing whenever a slice is used up. */
  async drain<T>(steps: Generator<void, T, void>): Promise<T> {
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
      if (this.due) await this.pause();
    }
  }
}

export interface ClaudeJsonlFile {
  records: Record<string, unknown>[];
  bytes: number;
}

function pushJsonlRecord(records: Record<string, unknown>[], line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      records.push(parsed as Record<string, unknown>);
    }
  } catch {
    // A corrupt row is skipped; the rest of the transcript still replays.
  }
}

/** Streams a JSONL file and parses each line exactly once. */
export async function readClaudeJsonlFile(
  filePath: string,
  slicer: ClaudeHistorySlicer,
): Promise<ClaudeJsonlFile> {
  const records: Record<string, unknown>[] = [];
  const stream = createReadStream(filePath, {
    encoding: "utf8",
    highWaterMark: TRANSCRIPT_READ_CHUNK_BYTES,
  });
  // A line longer than one chunk is joined once at its end, not re-concatenated per chunk.
  let partialLine: string[] = [];
  for await (const chunk of stream as AsyncIterable<string>) {
    let lineStart = 0;
    let newline = chunk.indexOf("\n");
    while (newline !== -1) {
      partialLine.push(chunk.slice(lineStart, newline));
      pushJsonlRecord(records, partialLine.length === 1 ? partialLine[0]! : partialLine.join(""));
      partialLine = [];
      lineStart = newline + 1;
      newline = chunk.indexOf("\n", lineStart);
    }
    if (lineStart < chunk.length) partialLine.push(chunk.slice(lineStart));
    if (slicer.due) await slicer.pause();
  }
  if (partialLine.length > 0) pushJsonlRecord(records, partialLine.join(""));
  return { records, bytes: stream.bytesRead };
}

export interface ClaudeSidechainHistory {
  /** Subagent transcripts outside workflows, in directory-walk order. */
  files: Record<string, unknown>[][];
  workflowContents: string[];
  workflowFilesByRunId: Map<string, Record<string, unknown>[][]>;
  /** agentId -> sidecar metadata, when Claude Code wrote one next to the transcript. */
  metaByAgentId: Map<string, ClaudeSubagentMeta>;
  transcriptFiles: number;
  transcriptBytes: number;
}

const CLAUDE_SUBAGENT_META_FILE = /^agent-(.+)\.meta\.json$/;

async function readDirectoryIfPresent(directory: string): Promise<Dirent[] | null> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw error;
  }
}

/** Reads the subagent and workflow files Claude Code keeps beside a session transcript. */
export async function readClaudeSidechainHistory(
  historyPath: string,
  slicer: ClaudeHistorySlicer,
): Promise<ClaudeSidechainHistory> {
  const sessionDirectory = path.join(
    path.dirname(historyPath),
    path.basename(historyPath, ".jsonl"),
  );
  const sidechainDirectory = path.join(sessionDirectory, "subagents");
  const history: ClaudeSidechainHistory = {
    files: [],
    workflowContents: [],
    workflowFilesByRunId: new Map(),
    metaByAgentId: new Map(),
    transcriptFiles: 0,
    transcriptBytes: 0,
  };
  const workflowDirectory = path.join(sessionDirectory, "workflows");
  for (const entry of (await readDirectoryIfPresent(workflowDirectory)) ?? []) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      history.workflowContents.push(
        await readFile(path.join(workflowDirectory, entry.name), "utf8"),
      );
    } catch {
      // A partial or unreadable run summary must not fail the rest of history ingestion.
    }
  }

  const sidechainEntries = await readDirectoryIfPresent(sidechainDirectory);
  if (!sidechainEntries) return history;
  const pending: Array<{ directory: string; entries: Dirent[] | null }> = [
    { directory: sidechainDirectory, entries: sidechainEntries },
  ];
  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) continue;
    const entries = next.entries ?? (await readdir(next.directory, { withFileTypes: true }));
    for (const entry of entries) {
      const entryPath = path.join(next.directory, entry.name);
      if (entry.isDirectory()) {
        pending.push({ directory: entryPath, entries: null });
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".jsonl")) {
        const file = await readClaudeJsonlFile(entryPath, slicer);
        history.transcriptFiles += 1;
        history.transcriptBytes += file.bytes;
        recordSidechainFile(history, sidechainDirectory, entryPath, file.records);
        continue;
      }
      // The sidecar carries the Task tool_use id, which is the same id the live stream keys on.
      // Reading it is what lets replay and live agree instead of each deriving its own link.
      const metaMatch = CLAUDE_SUBAGENT_META_FILE.exec(entry.name);
      if (!metaMatch?.[1]) continue;
      try {
        const meta = parseClaudeSubagentMeta(await readFile(entryPath, "utf8"));
        if (meta) history.metaByAgentId.set(metaMatch[1], meta);
      } catch {
        // Undocumented internals: a missing or unreadable sidecar must never fail ingestion.
      }
    }
  }
  return history;
}

function recordSidechainFile(
  history: ClaudeSidechainHistory,
  sidechainDirectory: string,
  entryPath: string,
  records: Record<string, unknown>[],
): void {
  const relativeParts = path.relative(sidechainDirectory, entryPath).split(path.sep);
  const workflowRunId =
    relativeParts[0] === "workflows" && relativeParts.length >= 3 ? relativeParts[1] : undefined;
  if (!workflowRunId) {
    history.files.push(records);
    return;
  }
  const workflowFiles = history.workflowFilesByRunId.get(workflowRunId) ?? [];
  workflowFiles.push(records);
  history.workflowFilesByRunId.set(workflowRunId, workflowFiles);
}
