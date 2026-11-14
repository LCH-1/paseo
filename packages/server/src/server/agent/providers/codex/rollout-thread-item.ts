/**
 * Converts the core `TurnItem` records Codex persists in paginated rollouts into the
 * `ThreadItem` JSON its app-server returns from `thread/read`, following codex-rs 0.167
 * (`app-server-protocol/src/protocol/v2/item.rs`, `item_builders.rs`). A record this module does
 * not recognize throws {@link CodexRolloutFormatError}, so the caller can ask app-server instead
 * of guessing.
 */

export class CodexRolloutFormatError extends Error {
  constructor(readonly detail: string) {
    super(`Unsupported Codex rollout record: ${detail}`);
    this.name = "CodexRolloutFormatError";
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw new CodexRolloutFormatError(`${field} is not an object`);
  return value;
}

function requireString(record: JsonRecord, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new CodexRolloutFormatError(`${field} is not a string`);
  return value;
}

function requireArray(record: JsonRecord, field: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) throw new CodexRolloutFormatError(`${field} is not an array`);
  return value;
}

function optionalString(record: JsonRecord, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CodexRolloutFormatError(`${field} is not a string`);
  return value;
}

function optionalArray(record: JsonRecord, field: string): unknown[] {
  const value = record[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CodexRolloutFormatError(`${field} is not an array`);
  return value;
}

function optionalValue(record: JsonRecord, field: string): unknown {
  return record[field] === undefined ? null : record[field];
}

function stringList(values: unknown[], field: string): string[] {
  return values.map((value) => {
    if (typeof value !== "string") throw new CodexRolloutFormatError(`${field} has a non-string`);
    return value;
  });
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

function enumValue(record: JsonRecord, field: string, allowed: ReadonlySet<string>): string {
  const value = requireString(record, field);
  if (!allowed.has(value)) throw new CodexRolloutFormatError(`${field} ${value}`);
  return snakeToCamel(value);
}

/** `std::time::Duration` serializes as `{ secs, nanos }`; app-server reports whole milliseconds. */
function durationMs(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || typeof value.secs !== "number" || typeof value.nanos !== "number") {
    throw new CodexRolloutFormatError("duration");
  }
  return value.secs * 1000 + Math.floor(value.nanos / 1_000_000);
}

const UNQUOTED_SAFE = /^[+\-./:@\]_0-9A-Za-z]$/;

function chunkStrategy(char: string): number {
  const code = char.charCodeAt(0);
  const unquoted = 1;
  const single = 2;
  const double = 4;
  if (code >= 0x80) return single | double;
  let allowed = unquoted | single | double;
  if (!UNQUOTED_SAFE.test(char)) allowed &= ~unquoted;
  if (char === "'" || char === "^" || char === "\\") allowed &= ~single;
  if (char === "`" || char === "$" || char === "!" || char === "^") allowed &= ~double;
  return allowed;
}

/** Rust `shlex` 1.3 `try_join` quoting, which app-server uses to present a command. */
function shlexQuote(word: string): string {
  if (word.length === 0) return "''";
  let out = "";
  let rest = word;
  while (rest.length > 0) {
    let allowed = 7;
    let index = 0;
    if (rest[0] === "^") {
      allowed = 2;
      index = 1;
    }
    for (; index < rest.length; index += 1) {
      const next = allowed & chunkStrategy(rest[index]!);
      if (next === 0) break;
      allowed = next;
    }
    const chunk = rest.slice(0, index);
    rest = rest.slice(index);
    if (allowed & 1) {
      if (out.length === 0 && rest.length === 0) return chunk;
      out += chunk;
    } else if (allowed & 2) {
      out += `'${chunk}'`;
    } else {
      out += `"${chunk.replace(/[$`"\\]/g, (char) => `\\${char}`)}"`;
    }
  }
  return out;
}

function shlexJoin(words: string[]): string {
  if (words.some((word) => word.includes("\0"))) return "<command included NUL byte>";
  return words.map(shlexQuote).join(" ");
}

// Rust's regex crate is Unicode-aware: `\b`, `\s` and case-insensitive matching follow Unicode.
const WORD = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]`;
// Only the word "Bearer" is case-insensitive there; folding the token class too would let
// characters such as the Kelvin sign count towards the token.
const BEARER_TOKEN = new RegExp(
  String.raw`(?<!${WORD})[Bb][Ee][Aa][Rr][Ee][Rr][ \t]+[A-Za-z0-9._~+/-]{16,}=*`,
  "gu",
);
const OPENAI_KEY = /sk-[A-Za-z0-9]{20,}/gu;
const AWS_ACCESS_KEY_ID = new RegExp(String.raw`(?<!${WORD})AKIA[0-9A-Z]{16}(?!${WORD})`, "gu");
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?<!${WORD})(api[_-]?key|token|secret|password)(?!${WORD})(\p{White_Space}*[:=]\p{White_Space}*)(["']?)[^\p{White_Space}"']{8,}`,
  "giu",
);

/** `codex_secrets::redact_secrets`, applied by app-server to every presented command. */
export function redactCodexSecrets(input: string): string {
  return input
    .replace(BEARER_TOKEN, "Bearer [REDACTED_SECRET]")
    .replace(OPENAI_KEY, "[REDACTED_SECRET]")
    .replace(AWS_ACCESS_KEY_ID, "[REDACTED_SECRET]")
    .replace(SECRET_ASSIGNMENT, "$1$2$3[REDACTED_SECRET]");
}

type PathConvention = "posix" | "windows";

interface ParsedFileUri {
  url: URL;
  segments: string[];
  convention: PathConvention;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // Codex decodes bytes lossily; a segment that is not valid percent-encoded UTF-8 is unusual
    // enough to hand to app-server.
    throw new CodexRolloutFormatError("path segment encoding");
  }
}

function parseFileUri(value: string): ParsedFileUri {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CodexRolloutFormatError("path URI");
  }
  if (url.protocol !== "file:" || url.search || url.hash) {
    throw new CodexRolloutFormatError("path URI");
  }
  const segments = url.pathname.slice(1).split("/");
  if (segments[0] === "%00") throw new CodexRolloutFormatError("opaque path URI");
  const host = url.hostname === "localhost" ? "" : url.hostname;
  const first = segments.find((segment) => segment.length > 0) ?? "";
  const hasDrive = /^[A-Za-z](:|%3[Aa])$/.test(first);
  const convention: PathConvention = host || hasDrive ? "windows" : "posix";
  return { url, segments, convention };
}

/** `PathUri::inferred_native_path_string`: how app-server renders a `file:` URI as a path. */
export function codexNativePath(value: string): string {
  const { url, segments, convention } = parseFileUri(value);
  const host = url.hostname === "localhost" ? "" : url.hostname;
  if (convention === "posix") {
    return segments.map((segment) => `/${decodeSegment(segment)}`).join("");
  }
  let rendered: string;
  let rest: string[];
  if (host) {
    const share = decodeSegment(segments[0] ?? "");
    if (!share) throw new CodexRolloutFormatError("UNC path without share");
    rendered = `\\\\${host}\\${share}`;
    rest = segments.slice(1);
  } else {
    const drive = decodeSegment(segments[0] ?? "");
    if (!/^[A-Za-z]:$/.test(drive)) throw new CodexRolloutFormatError("Windows path without drive");
    rendered = drive;
    rest = segments.slice(1);
  }
  for (const segment of rest) rendered += `\\${decodeSegment(segment)}`;
  return rendered.length === 2 ? `${rendered}\\` : rendered;
}

function isAbsoluteNativePath(value: string, convention: PathConvention): boolean {
  if (convention === "posix") return value.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value);
}

/** `cwd.join(path)` for read actions, which app-server resolves against the command's cwd. */
function joinCommandPath(cwd: string, file: string): string {
  const { convention } = parseFileUri(cwd);
  const separator = convention === "windows" ? "\\" : "/";
  if (isAbsoluteNativePath(file, convention)) {
    return convention === "windows" ? file.replaceAll("/", "\\") : file;
  }
  const base = codexNativePath(cwd);
  const anchor = convention === "windows" ? base.slice(0, 2) : "";
  const parts = base
    .slice(anchor.length)
    .split(separator)
    .filter((part) => part.length > 0);
  const splitter = convention === "windows" ? /[\\/]/ : /\//;
  for (const part of file.split(splitter)) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${anchor}${separator}${parts.join(separator)}`;
}

function convertCommandAction(value: unknown, cwd: string): JsonRecord | null {
  const parsed = requireRecord(value, "parsed_cmd");
  const type = requireString(parsed, "type");
  const command = redactCodexSecrets(requireString(parsed, "cmd"));
  switch (type) {
    case "read": {
      const file = requireString(parsed, "path");
      if (file.includes("\0")) return null;
      return {
        type: "read",
        command,
        name: requireString(parsed, "name"),
        path: joinCommandPath(cwd, file),
      };
    }
    case "list_files":
      return { type: "listFiles", command, path: optionalString(parsed, "path") };
    case "search": {
      const query = optionalString(parsed, "query");
      return {
        type: "search",
        command,
        query: query === null ? null : redactCodexSecrets(query),
        path: optionalString(parsed, "path"),
      };
    }
    case "unknown":
      return { type: "unknown", command };
    default:
      throw new CodexRolloutFormatError(`parsed command ${type}`);
  }
}

const COMMAND_SOURCES = new Set([
  "agent",
  "user_shell",
  "unified_exec_startup",
  "unified_exec_interaction",
]);
const COMMAND_STATUSES = new Set(["in_progress", "completed", "failed", "declined"]);
const PATCH_STATUSES = new Set(["completed", "failed", "declined"]);
const MCP_STATUSES = new Set(["inProgress", "completed", "failed"]);
const SUB_AGENT_KINDS = new Set(["started", "interacted", "interrupted", "completed"]);
const DYNAMIC_TOOL_STATUSES = new Set(["in_progress", "completed", "failed"]);

function convertCommandExecution(item: JsonRecord): JsonRecord {
  const argv = stringList(requireArray(item, "command"), "command");
  const cwd = requireString(item, "cwd");
  const actions = requireArray(item, "parsed_cmd")
    .map((action) => convertCommandAction(action, cwd))
    .filter((action): action is JsonRecord => action !== null);
  const output = optionalString(item, "aggregated_output");
  const exitCode = item.exit_code;
  if (exitCode !== undefined && exitCode !== null && typeof exitCode !== "number") {
    throw new CodexRolloutFormatError("exit_code");
  }
  const source = requireString(item, "source");
  if (!COMMAND_SOURCES.has(source)) throw new CodexRolloutFormatError(`source ${source}`);
  return {
    type: "commandExecution",
    id: requireString(item, "id"),
    pluginId: optionalString(item, "plugin_id"),
    scriptPath: optionalString(item, "script_path"),
    command: redactCodexSecrets(shlexJoin(argv)),
    cwd: codexNativePath(cwd),
    processId: optionalString(item, "process_id"),
    source: snakeToCamel(source),
    status: enumValue(item, "status", COMMAND_STATUSES),
    commandActions: actions,
    aggregatedOutput: output === "" ? null : output,
    exitCode: exitCode ?? null,
    durationMs: durationMs(item.duration),
  };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function convertFileChange(item: JsonRecord): JsonRecord {
  const changes = requireRecord(item.changes, "changes");
  const converted = Object.entries(changes).map(([file, value]) => {
    const change = requireRecord(value, "file change");
    const type = requireString(change, "type");
    switch (type) {
      case "add":
      case "delete":
        return { path: file, kind: { type }, diff: requireString(change, "content") };
      case "update": {
        const movePath = optionalString(change, "move_path");
        const diff = requireString(change, "unified_diff");
        return {
          path: file,
          kind: { type: "update", move_path: movePath },
          diff: movePath === null ? diff : `${diff}\n\nMoved to: ${movePath}`,
        };
      }
      default:
        throw new CodexRolloutFormatError(`file change ${type}`);
    }
  });
  converted.sort((left, right) => compareUtf8(left.path, right.path));
  const status =
    item.status === undefined || item.status === null
      ? "inProgress"
      : enumValue(item, "status", PATCH_STATUSES);
  return { type: "fileChange", id: requireString(item, "id"), changes: converted, status };
}

function convertMcpToolCall(item: JsonRecord): JsonRecord {
  if (!("arguments" in item)) throw new CodexRolloutFormatError("arguments");
  const connectorId = optionalString(item, "connectorId");
  const resourceUri = optionalString(item, "mcpAppResourceUri");
  const appContext =
    connectorId === null
      ? null
      : {
          connectorId,
          linkId: optionalString(item, "linkId"),
          resourceUri,
          appName: optionalString(item, "appName"),
          actionName: optionalString(item, "actionName"),
        };
  const result =
    item.result === undefined || item.result === null
      ? null
      : convertMcpResult(requireRecord(item.result, "result"));
  const error =
    item.error === undefined || item.error === null
      ? null
      : { message: requireString(requireRecord(item.error, "error"), "message") };
  return {
    type: "mcpToolCall",
    id: requireString(item, "id"),
    server: requireString(item, "server"),
    tool: requireString(item, "tool"),
    status: enumValue(item, "status", MCP_STATUSES),
    arguments: item.arguments,
    appContext,
    ...(resourceUri === null ? {} : { mcpAppResourceUri: resourceUri }),
    mcpAppUi: optionalValue(item, "mcpAppUi"),
    pluginId: optionalString(item, "pluginId"),
    readOnlyHint: optionalValue(item, "readOnlyHint"),
    result,
    error,
    durationMs: durationMs(item.duration),
  };
}

function convertMcpResult(result: JsonRecord): JsonRecord {
  return {
    content: requireArray(result, "content"),
    structuredContent: optionalValue(result, "structuredContent"),
    _meta: optionalValue(result, "_meta"),
  };
}

function convertUserInput(value: unknown): JsonRecord {
  const input = requireRecord(value, "user input");
  const type = requireString(input, "type");
  switch (type) {
    case "text":
      return {
        type: "text",
        text: requireString(input, "text"),
        text_elements: optionalArray(input, "text_elements").map(convertTextElement),
      };
    case "image":
      return {
        type: "image",
        ...imageReference(input, "image_url", "url"),
        detail: optionalValue(input, "detail"),
      };
    case "local_image":
      return {
        type: "localImage",
        detail: optionalValue(input, "detail"),
        path: requireString(input, "path"),
      };
    case "audio":
      return { type: "audio", ...imageReference(input, "audio_url", "url") };
    case "local_audio":
      return { type: "localAudio", path: requireString(input, "path") };
    case "skill":
      return {
        type: "skill",
        name: requireString(input, "name"),
        path: requireString(input, "path"),
      };
    case "mention":
      return {
        type: "mention",
        name: requireString(input, "name"),
        path: requireString(input, "path"),
      };
    default:
      throw new CodexRolloutFormatError(`user input ${type}`);
  }
}

function imageReference(input: JsonRecord, inlineField: string, inlineName: string): JsonRecord {
  if (typeof input[inlineField] === "string") return { [inlineName]: input[inlineField] };
  return { fileId: requireString(input, "file_id") };
}

function convertTextElement(value: unknown): JsonRecord {
  const element = requireRecord(value, "text element");
  const range = requireRecord(element.byte_range, "byte_range");
  return {
    byteRange: { start: range.start, end: range.end },
    placeholder: optionalValue(element, "placeholder"),
  };
}

function convertAgentMessage(item: JsonRecord): JsonRecord {
  const text = requireArray(item, "content")
    .map((entry) => {
      const content = requireRecord(entry, "agent message content");
      if (content.type !== "Text") throw new CodexRolloutFormatError("agent message content");
      return requireString(content, "text");
    })
    .join("");
  const citation = item.memory_citation;
  return {
    type: "agentMessage",
    id: requireString(item, "id"),
    text,
    phase: optionalValue(item, "phase"),
    memoryCitation:
      citation === undefined || citation === null ? null : convertMemoryCitation(citation),
    delivery: optionalValue(item, "delivery"),
    questions: optionalValue(item, "questions"),
  };
}

function convertMemoryCitation(value: unknown): JsonRecord {
  const citation = requireRecord(value, "memory_citation");
  return {
    entries: optionalArray(citation, "entries").map((entry) => {
      const record = requireRecord(entry, "memory citation entry");
      return {
        path: record.path,
        lineStart: record.line_start,
        lineEnd: record.line_end,
        note: record.note,
      };
    }),
    threadIds: optionalArray(citation, "rollout_ids"),
  };
}

const COLLAB_TOOLS = new Set([
  "spawn_agent",
  "send_input",
  "resume_agent",
  "wait",
  "close_agent",
  "send_message",
  "followup_task",
  "interrupt_agent",
  "list_agents",
]);
const COLLAB_STATUSES = new Set(["in_progress", "completed", "failed", "interrupted"]);
const AGENT_STATUS_UNITS = new Set([
  "pending_init",
  "running",
  "interrupted",
  "shutdown",
  "not_found",
]);

function convertAgentStatus(value: unknown): JsonRecord {
  if (typeof value === "string" && AGENT_STATUS_UNITS.has(value)) {
    return { status: snakeToCamel(value), message: null };
  }
  if (isRecord(value)) {
    const [key, message] = Object.entries(value)[0] ?? [];
    if (key === "completed" && (message === null || typeof message === "string")) {
      return { status: "completed", message };
    }
    if (key === "errored" && typeof message === "string") {
      return { status: "errored", message };
    }
  }
  throw new CodexRolloutFormatError("agent status");
}

function convertCollabAgentToolCall(item: JsonRecord): JsonRecord {
  const states =
    item.agents_states === undefined ? {} : requireRecord(item.agents_states, "agents_states");
  const agentsStates: JsonRecord = {};
  for (const [threadId, status] of Object.entries(states)) {
    agentsStates[threadId] = convertAgentStatus(status);
  }
  return {
    type: "collabAgentToolCall",
    id: requireString(item, "id"),
    tool: enumValue(item, "tool", COLLAB_TOOLS),
    status: enumValue(item, "status", COLLAB_STATUSES),
    senderThreadId: requireString(item, "sender_thread_id"),
    receiverThreadIds: stringList(
      optionalArray(item, "receiver_thread_ids"),
      "receiver_thread_ids",
    ),
    prompt: optionalString(item, "prompt"),
    model: optionalString(item, "model"),
    reasoningEffort: optionalValue(item, "reasoning_effort"),
    agentsStates,
  };
}

const WEB_SEARCH_ACTIONS = new Set(["search", "open_page", "find_in_page", "other"]);

/** Core actions are snake_case; app-server's are camelCase with every field present. */
function convertWebSearchAction(value: unknown, casing: "core" | "extension"): JsonRecord | null {
  if (value === undefined || value === null) return null;
  const action = requireRecord(value, "web search action");
  const rawType = requireString(action, "type");
  const type =
    casing === "core" ? rawType : rawType.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  if (!WEB_SEARCH_ACTIONS.has(type)) return { type: "other" };
  switch (type) {
    case "search":
      return {
        type: "search",
        query: optionalString(action, "query"),
        queries: action.queries === undefined ? null : action.queries,
      };
    case "open_page":
      return { type: "openPage", url: optionalString(action, "url") };
    case "find_in_page":
      return {
        type: "findInPage",
        url: optionalString(action, "url"),
        pattern: optionalString(action, "pattern"),
      };
    default:
      return { type: "other" };
  }
}

function convertWebSearch(item: JsonRecord, casing: "core" | "extension"): JsonRecord {
  if (casing === "core" && !("action" in item)) throw new CodexRolloutFormatError("action");
  return {
    type: "webSearch",
    id: requireString(item, "id"),
    query: requireString(item, "query"),
    action: convertWebSearchAction(item.action, casing),
    results: optionalValue(item, "results"),
  };
}

function imageGeneration(fields: {
  item: JsonRecord;
  revisedPrompt: unknown;
  savedPath: unknown;
  transparentBackground: unknown;
  failure: unknown;
  inputImages: unknown[];
  generationId: unknown;
}): JsonRecord {
  const { item } = fields;
  const image =
    typeof item.fileId === "string"
      ? { fileId: item.fileId }
      : { result: requireString(item, "result") };
  return {
    type: "imageGeneration",
    id: requireString(item, "id"),
    status: requireString(item, "status"),
    revisedPrompt: fields.revisedPrompt ?? null,
    ...image,
    transparentBackground: fields.transparentBackground ?? null,
    failure: fields.failure ?? null,
    ...(fields.savedPath === undefined || fields.savedPath === null
      ? {}
      : { savedPath: fields.savedPath }),
    ...(fields.inputImages.length > 0 ? { inputImages: fields.inputImages } : {}),
    generationId: fields.generationId ?? null,
  };
}

function convertExtension(item: JsonRecord): JsonRecord {
  const kind = requireString(item, "kind");
  switch (kind) {
    case "image_gen.generation":
      return imageGeneration({
        item,
        revisedPrompt: item.revisedPrompt,
        savedPath: item.savedPath,
        transparentBackground: item.transparentBackground,
        failure: item.failure,
        inputImages: optionalArray(item, "inputImages"),
        generationId: item.generationId,
      });
    case "clock.sleep":
      if (typeof item.durationMs !== "number") throw new CodexRolloutFormatError("durationMs");
      return { type: "sleep", id: requireString(item, "id"), durationMs: item.durationMs };
    case "web.search":
      return convertWebSearch(item, "extension");
    default:
      throw new CodexRolloutFormatError(`extension ${kind}`);
  }
}

function convertSubAgentActivity(item: JsonRecord): JsonRecord {
  return {
    type: "subAgentActivity",
    model: optionalString(item, "model"),
    reasoningEffort: optionalValue(item, "reasoning_effort"),
    id: requireString(item, "id"),
    kind: enumValue(item, "kind", SUB_AGENT_KINDS),
    agentThreadId: requireString(item, "agent_thread_id"),
    agentPath: requireString(item, "agent_path"),
  };
}

function convertDynamicToolCall(item: JsonRecord): JsonRecord {
  if (!("arguments" in item)) throw new CodexRolloutFormatError("arguments");
  return {
    type: "dynamicToolCall",
    id: requireString(item, "id"),
    namespace: optionalString(item, "namespace"),
    tool: requireString(item, "tool"),
    arguments: item.arguments,
    status: enumValue(item, "status", DYNAMIC_TOOL_STATUSES),
    contentItems: optionalValue(item, "content_items"),
    success: optionalValue(item, "success"),
    durationMs: durationMs(item.duration),
  };
}

/**
 * Review items render through Codex's review formatter, which Paseo never shows; keep the id and
 * the text Codex would show when no review output exists.
 */
function convertReviewItem(item: JsonRecord, type: "enteredReviewMode" | "exitedReviewMode") {
  const review = type === "enteredReviewMode" ? requireString(item, "user_facing_hint") : "";
  return { type, id: requireString(item, "id"), review };
}

export type CodexThreadItemPayload = JsonRecord & { type: string; id: string };

/** One persisted `TurnItem` as app-server's `ThreadItem` payload, without lifecycle times. */
export function codexThreadItemFromTurnItem(value: unknown): CodexThreadItemPayload {
  const item = requireRecord(value, "item");
  const type = requireString(item, "type");
  let payload: JsonRecord;
  switch (type) {
    case "UserMessage":
      payload = {
        type: "userMessage",
        id: requireString(item, "id"),
        clientId: optionalString(item, "client_id"),
        content: requireArray(item, "content").map(convertUserInput),
      };
      break;
    case "AgentMessage":
      payload = convertAgentMessage(item);
      break;
    case "Reasoning":
      payload = {
        type: "reasoning",
        id: requireString(item, "id"),
        summary: stringList(requireArray(item, "summary_text"), "summary_text"),
        content: stringList(optionalArray(item, "raw_content"), "raw_content"),
      };
      break;
    case "Plan":
      payload = { type: "plan", id: requireString(item, "id"), text: requireString(item, "text") };
      break;
    case "CommandExecution":
      payload = convertCommandExecution(item);
      break;
    case "FileChange":
      payload = convertFileChange(item);
      break;
    case "McpToolCall":
      payload = convertMcpToolCall(item);
      break;
    case "WebSearch":
      payload = convertWebSearch(item, "core");
      break;
    case "ImageView":
      payload = {
        type: "imageView",
        id: requireString(item, "id"),
        path: codexNativePath(requireString(item, "path")),
      };
      break;
    case "ImageGeneration":
      payload = imageGeneration({
        item,
        revisedPrompt: item.revised_prompt,
        savedPath: item.saved_path,
        transparentBackground: null,
        failure: null,
        inputImages: [],
        generationId: null,
      });
      break;
    case "Extension":
      payload = convertExtension(item);
      break;
    case "CollabAgentToolCall":
      payload = convertCollabAgentToolCall(item);
      break;
    case "SubAgentActivity":
      payload = convertSubAgentActivity(item);
      break;
    case "ContextCompaction":
      payload = { type: "contextCompaction", id: requireString(item, "id") };
      break;
    case "DynamicToolCall":
      payload = convertDynamicToolCall(item);
      break;
    case "HookPrompt":
      payload = {
        type: "hookPrompt",
        id: requireString(item, "id"),
        fragments: requireArray(item, "fragments"),
      };
      break;
    case "FunctionCallOutput":
      payload = {
        type: "functionCallOutput",
        id: requireString(item, "id"),
        name: requireString(item, "name"),
        namespace: optionalString(item, "namespace"),
        output: optionalValue(item, "output"),
      };
      break;
    case "EnteredReviewMode":
      payload = convertReviewItem(item, "enteredReviewMode");
      break;
    case "ExitedReviewMode":
      payload = convertReviewItem(item, "exitedReviewMode");
      break;
    default:
      throw new CodexRolloutFormatError(`item ${type}`);
  }
  return { ...payload, type: requireString(payload, "type"), id: requireString(payload, "id") };
}
