import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import * as zlib from "node:zlib";

import {
  CodexRolloutFormatError,
  codexThreadItemFromTurnItem,
  type CodexThreadItemPayload,
} from "./rollout-thread-item.js";

/**
 * Reads a closed Codex thread's history straight from its paginated rollout files, producing
 * the same `thread.turns` that `codex app-server` returns from `thread/read`. Starting an
 * app-server only to read history cost a process chain per read, and parsing its single
 * response line for a long thread held the daemon's event loop for seconds.
 *
 * This mirrors codex-rs 0.167: `thread-store/src/local/thread_history_materialization.rs`
 * (which lines count), `thread_history.rs` (how a line updates turns and items),
 * `rollout_lineage.rs` and `thread_history/segment_paging.rs` (how forks stitch rollouts
 * together). Anything it cannot place exactly throws, and the caller asks app-server instead.
 */

const HISTORY_SLICE_MS = 8;
const ROLLOUT_READ_CHUNK_BYTES = 256 * 1024;

export class CodexHistoryLoadAbandonedError extends Error {
  constructor() {
    super("Codex history load was abandoned");
    this.name = "CodexHistoryLoadAbandonedError";
  }
}

/** Runs history work in slices of a few milliseconds with the event loop in between. */
export class CodexHistorySlicer {
  private sliceStartedAt = performance.now();

  constructor(private readonly isCurrent: () => boolean = () => true) {}

  get due(): boolean {
    return performance.now() - this.sliceStartedAt >= HISTORY_SLICE_MS;
  }

  async pause(): Promise<void> {
    await waitForImmediate();
    if (!this.isCurrent()) throw new CodexHistoryLoadAbandonedError();
    this.sliceStartedAt = performance.now();
  }
}

/** The thread's rollout cannot be read without app-server; `reason` says why for the log. */
export class CodexRolloutUnavailableError extends Error {
  constructor(
    readonly rolloutId: string,
    readonly reason: string,
  ) {
    super(`Codex rollout ${rolloutId} cannot be read directly: ${reason}`);
    this.name = "CodexRolloutUnavailableError";
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLLOUT_FILE_NAME =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl(\.zst)?$/;

const ROLLOUT_LINE_TYPES = new Set([
  "session_meta",
  "dynamic_tools_updated",
  "response_item",
  "inter_agent_communication",
  "inter_agent_communication_metadata",
  "compacted",
  "turn_context",
  "token_usage_record",
  "world_state",
  "retained_context",
  "security_risk_score",
  "event_msg",
  "realtime_item",
]);

// Every `EventMsg` variant Codex 0.167 can write. Only turn lifecycle and `item_completed`
// change paginated history; an event outside this list may come from a newer Codex whose history
// rules this reader does not know.
const EVENT_TYPES = new Set([
  "error",
  "warning",
  "auth_recovery_started",
  "auth_recovery_completed",
  "guardian_warning",
  "realtime_conversation_started",
  "realtime_conversation_realtime",
  "realtime_conversation_closed",
  "realtime_conversation_sdp",
  "model_reroute",
  "model_verification",
  "turn_moderation_metadata",
  "safety_buffering",
  "context_compacted",
  "thread_rolled_back",
  "task_started",
  "turn_started",
  "thread_settings_applied",
  "task_complete",
  "turn_complete",
  "token_count",
  "agent_message",
  "user_message",
  "agent_reasoning",
  "agent_reasoning_raw_content",
  "agent_reasoning_section_break",
  "session_configured",
  "environment_connected",
  "environment_disconnected",
  "thread_goal_updated",
  "thread_queue_changed",
  "mcp_startup_update",
  "mcp_startup_complete",
  "mcp_tool_call_begin",
  "mcp_tool_call_end",
  "web_search_begin",
  "web_search_end",
  "image_generation_begin",
  "image_generation_end",
  "exec_command_begin",
  "exec_command_output_delta",
  "terminal_interaction",
  "exec_command_end",
  "view_image_tool_call",
  "exec_approval_request",
  "network_approval_resolved",
  "request_permissions",
  "request_user_input",
  "dynamic_tool_call_request",
  "dynamic_tool_call_response",
  "elicitation_request",
  "elicitation_abandoned",
  "apply_patch_approval_request",
  "guardian_assessment",
  "deprecation_notice",
  "stream_error",
  "patch_apply_begin",
  "patch_apply_updated",
  "patch_apply_end",
  "turn_diff",
  "realtime_conversation_list_voices_response",
  "plan_update",
  "turn_aborted",
  "shutdown_complete",
  "entered_review_mode",
  "exited_review_mode",
  "raw_response_item",
  "raw_response_completed",
  "private_session_event",
  "item_started",
  "item_completed",
  "hook_started",
  "hook_completed",
  "agent_message_content_delta",
  "plan_delta",
  "reasoning_content_delta",
  "reasoning_raw_content_delta",
  "collab_agent_spawn_begin",
  "collab_agent_spawn_end",
  "collab_agent_interaction_begin",
  "collab_agent_interaction_end",
  "collab_waiting_begin",
  "collab_waiting_end",
  "collab_close_begin",
  "collab_close_end",
  "collab_resume_begin",
  "collab_resume_end",
  "sub_agent_activity",
]);

const TURN_ABORT_REASONS = new Set(["interrupted", "replaced", "review_ended", "budget_limited"]);

type TurnStatus = "inProgress" | "completed" | "failed" | "interrupted";

interface ProjectedTurn {
  ordinal: number;
  rootTurnId: string | null;
  status: TurnStatus;
  error: JsonRecord | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

interface ProjectedItem {
  ordinal: number;
  payload: CodexThreadItemPayload;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

interface HistoryPosition {
  rolloutId: string;
  endOrdinalExclusive: number;
  endByteOffset: number;
}

interface RolloutSessionMeta {
  id: string;
  historyBase: HistoryPosition | null;
  subagentHistoryStartOrdinal: number | null;
}

export interface CodexRolloutProjection {
  meta: RolloutSessionMeta;
  turns: Map<string, ProjectedTurn>;
  itemsByTurn: Map<string, Map<string, ProjectedItem>>;
  bytes: number;
}

interface TurnChange {
  turnId: string;
  turn: Omit<ProjectedTurn, "ordinal">;
}

interface ItemChange {
  turnId: string;
  payload: CodexThreadItemPayload;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

type LineChange = TurnChange | ItemChange | null;

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalInteger(record: JsonRecord, field: string): number | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CodexRolloutFormatError(`${field} is not an integer`);
  }
  return value;
}

function optionalTurnId(record: JsonRecord, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CodexRolloutFormatError(`${field} is not a string`);
  return value;
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

function camelCaseValue(value: unknown): unknown {
  if (typeof value === "string") return snakeToCamel(value);
  if (!isRecord(value)) return value;
  const converted: JsonRecord = {};
  for (const [key, entry] of Object.entries(value))
    converted[snakeToCamel(key)] = camelCaseValue(entry);
  return converted;
}

/** The `TurnError` app-server reports for a stored turn: no misalignment, no extra details. */
function turnError(value: unknown): JsonRecord | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || typeof value.message !== "string") {
    throw new CodexRolloutFormatError("turn error");
  }
  return {
    message: value.message,
    codexErrorInfo:
      value.codex_error_info === undefined ? null : camelCaseValue(value.codex_error_info),
    additionalDetails: null,
    misalignment: null,
  };
}

/** `project_rollout_line`: the history change one decoded line makes, if any. */
function projectLine(type: string, payload: unknown): LineChange {
  if (type !== "event_msg" || !isRecord(payload)) return null;
  const event = payload;
  switch (event.type) {
    case "task_started":
    case "turn_started":
      if (typeof event.turn_id !== "string") throw new CodexRolloutFormatError("turn_id");
      return {
        turnId: event.turn_id,
        turn: {
          rootTurnId: optionalTurnId(event, "root_turn_id"),
          status: "inProgress",
          error: null,
          startedAt: optionalInteger(event, "started_at"),
          completedAt: null,
          durationMs: null,
        },
      };
    case "task_complete":
    case "turn_complete": {
      if (typeof event.turn_id !== "string") throw new CodexRolloutFormatError("turn_id");
      const error = turnError(event.error);
      return {
        turnId: event.turn_id,
        turn: {
          rootTurnId: optionalTurnId(event, "root_turn_id"),
          status: error ? "failed" : "completed",
          error,
          startedAt: optionalInteger(event, "started_at"),
          completedAt: optionalInteger(event, "completed_at"),
          durationMs: optionalInteger(event, "duration_ms"),
        },
      };
    }
    case "turn_aborted": {
      if (typeof event.reason !== "string" || !TURN_ABORT_REASONS.has(event.reason)) {
        throw new CodexRolloutFormatError("turn_aborted reason");
      }
      const turnId = optionalTurnId(event, "turn_id");
      if (turnId === null) return null;
      return {
        turnId,
        turn: {
          rootTurnId: optionalTurnId(event, "root_turn_id"),
          status: "interrupted",
          error: turnError(event.error),
          startedAt: optionalInteger(event, "started_at"),
          completedAt: optionalInteger(event, "completed_at"),
          durationMs: optionalInteger(event, "duration_ms"),
        },
      };
    }
    case "item_completed": {
      if (typeof event.thread_id !== "string" || !UUID.test(event.thread_id)) {
        throw new CodexRolloutFormatError("item_completed thread_id");
      }
      if (typeof event.turn_id !== "string") throw new CodexRolloutFormatError("turn_id");
      const completedAtMs = optionalInteger(event, "completed_at_ms") ?? 0;
      return {
        turnId: event.turn_id,
        payload: codexThreadItemFromTurnItem(event.item),
        startedAtMs: optionalInteger(event, "started_at_ms"),
        completedAtMs: completedAtMs === 0 ? null : completedAtMs,
      };
    }
    default:
      return null;
  }
}

// RFC 3339 as chrono parses it for `fallback_created_at_ms`.
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function applyChange(
  projection: CodexRolloutProjection,
  ordinal: number,
  change: LineChange,
): void {
  if (change === null) return;
  if ("turn" in change) {
    const existing = projection.turns.get(change.turnId);
    if (!existing) {
      projection.turns.set(change.turnId, { ordinal, ...change.turn });
      return;
    }
    // A stored turn only moves on while in progress; it keeps the ordinal of its first record.
    if (existing.status !== "inProgress") return;
    projection.turns.set(change.turnId, {
      ...change.turn,
      ordinal: existing.ordinal,
      rootTurnId: existing.rootTurnId ?? change.turn.rootTurnId,
    });
    return;
  }
  let items = projection.itemsByTurn.get(change.turnId);
  if (!items) {
    items = new Map();
    projection.itemsByTurn.set(change.turnId, items);
  }
  const existing = items.get(change.payload.id);
  if (!existing) {
    items.set(change.payload.id, {
      ordinal,
      payload: change.payload,
      startedAtMs: change.startedAtMs,
      completedAtMs: change.completedAtMs,
    });
    return;
  }
  // A repeated item keeps its position and first recorded times; its body is the latest.
  existing.payload = change.payload;
  existing.startedAtMs ??= change.startedAtMs;
  existing.completedAtMs ??= change.completedAtMs;
}

function parseHistoryPosition(value: unknown): HistoryPosition | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.thread_id !== "string" ||
    !UUID.test(value.thread_id) ||
    !nonNegativeInteger(value.end_ordinal_exclusive) ||
    !nonNegativeInteger(value.end_byte_offset)
  ) {
    throw new CodexRolloutFormatError("history_base");
  }
  return {
    rolloutId: value.thread_id,
    endOrdinalExclusive: value.end_ordinal_exclusive,
    endByteOffset: value.end_byte_offset,
  };
}

function parseSessionMeta(rolloutId: string, line: unknown): RolloutSessionMeta {
  if (!isRecord(line) || line.type !== "session_meta" || !isRecord(line.payload)) {
    throw new CodexRolloutUnavailableError(rolloutId, "first record is not session metadata");
  }
  const meta = line.payload;
  if (typeof meta.id !== "string" || !UUID.test(meta.id)) {
    throw new CodexRolloutFormatError("session id");
  }
  if (meta.history_mode !== "paginated") {
    throw new CodexRolloutUnavailableError(rolloutId, "legacy history mode");
  }
  // An attached child stops its lineage at the parent bookmark, which needs its fork metadata.
  if (meta.attached_thread === true) {
    throw new CodexRolloutUnavailableError(rolloutId, "attached thread");
  }
  const start = meta.subagent_history_start_ordinal;
  if (start !== undefined && start !== null && !nonNegativeInteger(start)) {
    throw new CodexRolloutFormatError("subagent_history_start_ordinal");
  }
  return {
    id: meta.id,
    historyBase: parseHistoryPosition(meta.history_base),
    subagentHistoryStartOrdinal: nonNegativeInteger(start) ? start : null,
  };
}

/** Node added zstd in 22.15; Paseo's Node typings predate it. */
function createZstdDecompress(): Transform | null {
  const create: unknown = Reflect.get(zlib, "createZstdDecompress");
  if (typeof create !== "function") return null;
  const stream: unknown = Reflect.apply(create, zlib, []);
  return stream instanceof Transform ? stream : null;
}

async function openRolloutStream(file: RolloutFile): Promise<Readable | null> {
  if (!file.compressed) {
    // Read the bytes present now; a writer appending meanwhile waits for the next read.
    const { size } = await stat(file.path);
    if (size === 0) return null;
    return createReadStream(file.path, { end: size - 1, highWaterMark: ROLLOUT_READ_CHUNK_BYTES });
  }
  const decompress = createZstdDecompress();
  if (!decompress) {
    throw new CodexRolloutUnavailableError(file.rolloutId, "zstd is unavailable in this Node.js");
  }
  const source = createReadStream(file.path, { highWaterMark: ROLLOUT_READ_CHUNK_BYTES });
  source.on("error", (error) => decompress.destroy(error));
  // A read that stops early destroys the decompressor; the file must close with it.
  decompress.once("close", () => source.destroy());
  return source.pipe(decompress);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

// Codex writes `timestamp`, `ordinal`, `type`, then the payload, whose event tag comes first.
const LINE_PREFIX =
  /^\{"timestamp":"([^"\\]*)","ordinal":(\d{1,15}),"type":"([a-z_]+)","payload":(?:\{"type":"([a-z_]+)")?/;
const LINE_PREFIX_BYTES = 256;
const HISTORY_EVENT_TYPES = new Set([
  "task_started",
  "turn_started",
  "task_complete",
  "turn_complete",
  "turn_aborted",
  "item_completed",
]);

/**
 * The fields history needs from a line that cannot change it, read from its prefix. Model
 * context, compaction snapshots and usage records are two thirds of a rollout's bytes and its
 * largest lines; parsing them only to skip them doubled the read.
 */
function skippedLineRecord(prefix: string): JsonRecord | null {
  const match = LINE_PREFIX.exec(prefix);
  if (!match) return null;
  const [, timestamp, ordinal, type, eventType] = match;
  if (type === "session_meta") return null;
  if (type !== "event_msg") return { timestamp, ordinal: Number(ordinal), type };
  if (eventType === undefined || HISTORY_EVENT_TYPES.has(eventType)) return null;
  return { timestamp, ordinal: Number(ordinal), type, payload: { type: eventType } };
}

/**
 * The line's first bytes, one character each. A line that starts just before the end of a read
 * chunk continues in the next ones, and its prefix must too, or the line is parsed whole.
 */
function linePrefix(parts: Buffer[]): string {
  let prefix = "";
  for (const part of parts) {
    prefix += part.toString("latin1", 0, LINE_PREFIX_BYTES - prefix.length);
    if (prefix.length >= LINE_PREFIX_BYTES) break;
  }
  return prefix;
}

/** A complete line as JSON, or undefined where Codex would skip it as blank or malformed. */
function decodeLine(parts: Buffer[], parseAll: boolean): unknown {
  const skipped = parseAll ? null : skippedLineRecord(linePrefix(parts));
  if (skipped) return skipped;
  const bytes = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return undefined;
  }
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface ProjectionCursor {
  projection: CodexRolloutProjection | null;
  nextOrdinal: number;
}

/** The record's line type, refusing types a newer Codex may have given history meaning. */
function knownLineType(record: JsonRecord): string {
  if (typeof record.type !== "string" || !ROLLOUT_LINE_TYPES.has(record.type)) {
    throw new CodexRolloutFormatError(`rollout line ${String(record.type)}`);
  }
  if (record.type === "event_msg") {
    const eventType = isRecord(record.payload) ? record.payload.type : undefined;
    if (typeof eventType !== "string" || !EVENT_TYPES.has(eventType)) {
      throw new CodexRolloutFormatError(`event ${String(eventType)}`);
    }
  }
  return record.type;
}

function startProjection(
  file: RolloutFile,
  cursor: ProjectionCursor,
  record: unknown,
): CodexRolloutProjection {
  if (cursor.projection) return cursor.projection;
  const meta = parseSessionMeta(file.rolloutId, record);
  const projection: CodexRolloutProjection = {
    meta,
    turns: new Map(),
    itemsByTurn: new Map(),
    bytes: 0,
  };
  cursor.projection = projection;
  cursor.nextOrdinal = meta.historyBase?.endOrdinalExclusive ?? 0;
  return projection;
}

/** One complete line of the rollout, in file order. */
function visitRecord(file: RolloutFile, cursor: ProjectionCursor, record: unknown): void {
  const projection = startProjection(file, cursor, record);
  // Codex skips records it cannot decode without consuming an ordinal.
  if (!isRecord(record) || typeof record.timestamp !== "string") return;
  const type = knownLineType(record);
  const ordinal = record.ordinal;
  if (!nonNegativeInteger(ordinal) || ordinal < cursor.nextOrdinal) return;
  const start = projection.meta.subagentHistoryStartOrdinal;
  const inherited = start !== null && ordinal < start;
  const change = inherited ? null : projectLine(type, record.payload);
  const needsLineTime = change !== null && "payload" in change && change.startedAtMs === null;
  // Codex takes an untimed item's creation time from its line and drops a line without one.
  const lineTimeMissing =
    !RFC3339.test(record.timestamp) || Number.isNaN(Date.parse(record.timestamp));
  if (!(needsLineTime && lineTimeMissing)) applyChange(projection, ordinal, change);
  cursor.nextOrdinal = ordinal + 1;
}

/** Projects one rollout file the way Codex materializes it into its thread-history store. */
async function projectRollout(
  file: RolloutFile,
  slicer: CodexHistorySlicer,
): Promise<CodexRolloutProjection> {
  const stream = await openRolloutStream(file);
  if (!stream) throw new CodexRolloutUnavailableError(file.rolloutId, "empty rollout");
  const cursor: ProjectionCursor = { projection: null, nextOrdinal: 0 };
  let bytes = 0;
  let partial: Buffer[] = [];
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk))
      throw new CodexRolloutUnavailableError(file.rolloutId, "text stream");
    bytes += chunk.length;
    let lineStart = 0;
    let newline = chunk.indexOf(0x0a);
    while (newline !== -1) {
      partial.push(chunk.subarray(lineStart, newline));
      const record = decodeLine(partial, cursor.projection === null);
      partial = [];
      if (record !== undefined || cursor.projection !== null) visitRecord(file, cursor, record);
      lineStart = newline + 1;
      if (slicer.due) await slicer.pause();
      newline = chunk.indexOf(0x0a, lineStart);
    }
    // Only newline-terminated records count; a trailing partial one is still being written.
    if (lineStart < chunk.length) partial.push(chunk.subarray(lineStart));
  }
  const projection = cursor.projection;
  if (!projection) throw new CodexRolloutUnavailableError(file.rolloutId, "no session metadata");
  projection.bytes = bytes;
  return projection;
}

interface RolloutFile {
  rolloutId: string;
  path: string;
  compressed: boolean;
}

interface RolloutFileName {
  threadId: string;
  rolloutId: string;
  compressed: boolean;
  path: string;
}

function uuidV7Millis(id: string): number | null {
  if (id[14] !== "7") return null;
  return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}${month}${day}`;
}

async function readDirectoryIfPresent(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
    throw error;
  }
}

function parseRolloutFileName(directory: string, name: string): RolloutFileName | null {
  const match = ROLLOUT_FILE_NAME.exec(name);
  if (!match?.[1]) return null;
  return {
    threadId: match[1],
    rolloutId: match[2] ?? match[1],
    compressed: match[3] !== undefined,
    path: path.join(directory, name),
  };
}

interface DatedDirectory {
  path: string;
  /** The date its path spells so far, such as `202610` for `2026/10`. */
  key: string;
}

/**
 * Rollout files under `sessions/YYYY/MM/DD` from the local day before `sinceMs` on (all of them
 * without a time), then `archived_sessions`. Codex names a rollout by the local time its id was
 * created, and a thread can only gain rollouts later than that.
 */
async function listRolloutFiles(
  codexHome: string,
  sinceMs: number | null,
): Promise<RolloutFileName[]> {
  const since = sinceMs === null ? "" : localDayKey(new Date(sinceMs - 86_400_000));
  const sessions = path.join(codexHome, "sessions");
  // Each level keeps the directories whose date prefix can still reach `since`.
  let directories: DatedDirectory[] = [{ path: sessions, key: "" }];
  for (const keyLength of [4, 6, 8]) {
    const next: DatedDirectory[] = [];
    for (const directory of directories) {
      for (const entry of await readDirectoryIfPresent(directory.path)) {
        const key = `${directory.key}${entry.name}`;
        if (entry.isDirectory() && key >= since.slice(0, keyLength)) {
          next.push({ path: path.join(directory.path, entry.name), key });
        }
      }
    }
    directories = next;
  }
  directories.push({ path: path.join(codexHome, "archived_sessions"), key: "" });
  const files: RolloutFileName[] = [];
  for (const directory of directories) {
    for (const entry of await readDirectoryIfPresent(directory.path)) {
      const parsed = entry.isFile() ? parseRolloutFileName(directory.path, entry.name) : null;
      if (parsed) files.push(parsed);
    }
  }
  return files;
}

/** Codex reads a plain rollout before its compressed sibling. */
function selectRolloutFile(rolloutId: string, candidates: RolloutFileName[]): RolloutFile {
  const bases = new Set(candidates.map((file) => file.path.replace(/\.zst$/, "")));
  if (bases.size > 1) throw new CodexRolloutUnavailableError(rolloutId, "several rollouts match");
  const file = candidates.find((candidate) => !candidate.compressed) ?? candidates[0];
  if (!file) throw new CodexRolloutUnavailableError(rolloutId, "no rollout file");
  return { rolloutId, path: file.path, compressed: file.compressed };
}

/** The rollout a thread reads from. After `thread/revert` only Codex's database knows which. */
async function resolveThreadRollout(codexHome: string, threadId: string): Promise<RolloutFile> {
  if (!UUID.test(threadId)) throw new CodexRolloutUnavailableError(threadId, "not a thread id");
  const owned = (await listRolloutFiles(codexHome, uuidV7Millis(threadId))).filter(
    (file) => file.threadId === threadId,
  );
  if (owned.some((file) => file.rolloutId !== threadId)) {
    throw new CodexRolloutUnavailableError(threadId, "thread has reverted rollouts");
  }
  const active = owned.filter(
    (file) => !file.path.includes(`${path.sep}archived_sessions${path.sep}`),
  );
  return selectRolloutFile(threadId, active.length > 0 ? active : owned);
}

async function resolveRolloutById(codexHome: string, rolloutId: string): Promise<RolloutFile> {
  const files = (await listRolloutFiles(codexHome, uuidV7Millis(rolloutId))).filter(
    (file) => file.rolloutId === rolloutId,
  );
  return selectRolloutFile(rolloutId, files);
}

interface LineageSegment {
  projection: CodexRolloutProjection;
  startOrdinal: number;
  endOrdinal: number | null;
}

function inSegment(ordinal: number, segment: LineageSegment): boolean {
  return (
    ordinal >= segment.startOrdinal && (segment.endOrdinal === null || ordinal < segment.endOrdinal)
  );
}

export interface CodexRolloutThread {
  thread: { id: string; turns: JsonRecord[] };
  rolloutFiles: number;
  rolloutBytes: number;
}

/** Rollouts already projected during one history load, by path. */
export type CodexRolloutProjectionCache = Map<string, CodexRolloutProjection>;

export interface CodexRolloutReadOptions {
  codexHome: string;
  threadId: string;
  slicer: CodexHistorySlicer;
  projections?: CodexRolloutProjectionCache;
}

async function loadProjection(
  file: RolloutFile,
  options: CodexRolloutReadOptions,
): Promise<CodexRolloutProjection> {
  const cached = options.projections?.get(file.path);
  if (cached) return cached;
  const projection = await projectRollout(file, options.slicer);
  options.projections?.set(file.path, projection);
  return projection;
}

/** `resolve_rollout_lineage_for_history_page`: the rollout ranges a forked thread reads. */
async function resolveLineage(options: CodexRolloutReadOptions): Promise<LineageSegment[]> {
  const segments: LineageSegment[] = [];
  const seen = new Set<string>();
  let file = await resolveThreadRollout(options.codexHome, options.threadId);
  let end: HistoryPosition | null = null;
  for (;;) {
    if (seen.has(file.rolloutId)) throw new CodexRolloutUnavailableError(file.rolloutId, "cycle");
    seen.add(file.rolloutId);
    const projection = await loadProjection(file, options);
    if (segments.length === 0 && projection.meta.id !== options.threadId) {
      throw new CodexRolloutUnavailableError(file.rolloutId, "rollout belongs to another thread");
    }
    if (end && (end.endOrdinalExclusive === 0 || end.endByteOffset > projection.bytes)) {
      throw new CodexRolloutUnavailableError(file.rolloutId, "fork point is outside the rollout");
    }
    const base = projection.meta.historyBase;
    segments.push({
      projection,
      startOrdinal: base ? base.endOrdinalExclusive + 1 : 1,
      endOrdinal: end?.endOrdinalExclusive ?? null,
    });
    if (!base) break;
    end = base;
    file = await resolveRolloutById(options.codexHome, base.rolloutId);
  }
  return segments.toReversed();
}

/** A turn's items from every segment, in rollout order, as `ThreadItem`s. */
function turnItems(segments: LineageSegment[], turnId: string): JsonRecord[] {
  const items: JsonRecord[] = [];
  for (const segment of segments) {
    const segmentItems = segment.projection.itemsByTurn.get(turnId)?.values() ?? [];
    for (const item of segmentItems) {
      if (!inSegment(item.ordinal, segment)) continue;
      const threadItem: JsonRecord = Object.assign({}, item.payload);
      threadItem.startedAtMs = item.startedAtMs;
      threadItem.completedAtMs = item.completedAtMs;
      items.push(threadItem);
    }
  }
  return items;
}

/**
 * The thread's turns in `thread/read` order: each segment's turns that no newer segment
 * redefines, each with its items from every segment in rollout order.
 */
async function assembleTurns(
  segments: LineageSegment[],
  slicer: CodexHistorySlicer,
): Promise<JsonRecord[]> {
  const turns: JsonRecord[] = [];
  for (const [index, segment] of segments.entries()) {
    const newer = segments.slice(index + 1);
    for (const [turnId, turn] of segment.projection.turns) {
      if (!inSegment(turn.ordinal, segment)) continue;
      const redefined = newer.some((later) => {
        const laterTurn = later.projection.turns.get(turnId);
        return laterTurn !== undefined && inSegment(laterTurn.ordinal, later);
      });
      if (redefined) continue;
      // A closed thread has no running turn; app-server reports an unfinished one as interrupted.
      const status: TurnStatus = turn.status === "inProgress" ? "interrupted" : turn.status;
      turns.push({
        id: turnId,
        rootTurnId: turn.rootTurnId,
        items: turnItems(segments, turnId),
        itemsView: "full",
        status,
        error: turn.error,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        durationMs: turn.durationMs,
      });
      if (slicer.due) await slicer.pause();
    }
  }
  return turns;
}

/** A `thread/read` response built from the thread's rollout files, without app-server. */
export async function readCodexThreadFromRollouts(
  options: CodexRolloutReadOptions,
): Promise<CodexRolloutThread> {
  const segments = await resolveLineage(options);
  const turns = await assembleTurns(segments, options.slicer);
  return {
    thread: { id: options.threadId, turns },
    rolloutFiles: segments.length,
    rolloutBytes: segments.reduce((total, segment) => total + segment.projection.bytes, 0),
  };
}
