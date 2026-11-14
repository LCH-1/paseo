import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as zlib from "node:zlib";

/** Node added zstd in 22.15; Paseo's Node typings predate it. */
function zstdCompress(input: Buffer): Buffer | null {
  const compress: unknown = Reflect.get(zlib, "zstdCompressSync");
  if (typeof compress !== "function") return null;
  const output: unknown = Reflect.apply(compress, zlib, [input]);
  return Buffer.isBuffer(output) ? output : null;
}

/**
 * Synthetic paginated Codex rollouts covering what history replay has to agree on: ordinary turns,
 * tool calls and their output, images, sub-agents, compaction, a rewind fork, a mid-turn fork, a
 * compressed rollout and a thread whose last turn is still running.
 *
 * `rollout-fixture.thread-read.json` holds what `codex app-server` 0.167.0 answered to
 * `thread/read` for these files in a throwaway CODEX_HOME. App-server answers from a SQLite
 * projection it only builds for threads it writes or forks, so each thread was forked once
 * (which left its rollout untouched) before it was read. The builders here are deterministic,
 * so the same bytes are rebuilt for every test run.
 */

interface RecordedThreadRead {
  codexVersion: string;
  threads: Record<string, { turns: unknown[] }>;
}

const recordedThreadRead: RecordedThreadRead = JSON.parse(
  readFileSync(new URL("./rollout-fixture.thread-read.json", import.meta.url), "utf8"),
);

/** The turns Codex app-server returned for a fixture thread. */
export function recordedThreadTurns(threadId: string): unknown[] {
  return recordedThreadRead.threads[threadId]?.turns ?? [];
}

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";

function fixtureUuidV7(ms: number, sequence: number): string {
  const time = ms.toString(16).padStart(12, "0");
  const tail = sequence.toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7000-8000-${tail}`;
}

const BASE_MS = Date.UTC(2026, 9, 20, 3, 4, 5);

export const ROLLOUT_FIXTURE_THREADS = {
  root: fixtureUuidV7(BASE_MS, 1),
  child: fixtureUuidV7(BASE_MS + 60_000, 2),
  grandchild: fixtureUuidV7(BASE_MS + 90_000, 3),
  fork: fixtureUuidV7(BASE_MS + 3_600_000, 4),
  midFork: fixtureUuidV7(BASE_MS + 3_700_000, 5),
  compressed: fixtureUuidV7(BASE_MS + 86_400_000, 6),
  live: fixtureUuidV7(BASE_MS + 2 * 86_400_000, 7),
} as const;

export const ROLLOUT_FIXTURE_TURNS = {
  root: ["turn-r1", "turn-r2", "turn-r3", "turn-r4", "turn-r5", "turn-r6"],
  fork: ["turn-f1"],
  midFork: ["turn-m1"],
} as const;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Codex names and files a rollout by the local wall-clock time its thread id was created. */
export function fixtureRolloutPath(
  codexHome: string,
  threadId: string,
  compressed = false,
): string {
  const ms = Number.parseInt(threadId.replaceAll("-", "").slice(0, 12), 16);
  const date = new Date(ms);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return path.join(
    codexHome,
    "sessions",
    String(date.getFullYear()),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    `rollout-${day}T${time}-${threadId}.jsonl${compressed ? ".zst" : ""}`,
  );
}

interface RolloutLineOptions {
  ordinal?: number | null;
  timestamp?: string;
}

/** Writes rollout lines with Codex's ordinal numbering and remembers their byte offsets. */
export class RolloutBuilder {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private clock: number;
  nextOrdinal: number;

  constructor(startOrdinal: number, startMs: number) {
    this.nextOrdinal = startOrdinal;
    this.clock = startMs;
  }

  get byteLength(): number {
    return this.bytes;
  }

  timestamp(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  seconds(): number {
    return Math.floor(this.clock / 1000);
  }

  millis(): number {
    return this.clock;
  }

  line(type: string, payload: unknown, options: RolloutLineOptions = {}): this {
    const ordinal = options.ordinal === undefined ? this.nextOrdinal : options.ordinal;
    const record: Record<string, unknown> = {
      timestamp: options.timestamp ?? this.timestamp(),
      ...(ordinal === null ? {} : { ordinal }),
      type,
      payload,
    };
    if (ordinal !== null && ordinal >= this.nextOrdinal) {
      this.nextOrdinal = ordinal + 1;
    }
    return this.raw(`${JSON.stringify(record)}\n`);
  }

  raw(text: string): this {
    this.chunks.push(text);
    this.bytes += Buffer.byteLength(text);
    return this;
  }

  event(payload: Record<string, unknown>, options?: RolloutLineOptions): this {
    return this.line("event_msg", payload, options);
  }

  turnStarted(turnId: string): this {
    return this.event({
      type: "task_started",
      turn_id: turnId,
      started_at: this.seconds(),
      model_context_window: 272000,
      collaboration_mode_kind: "default",
    });
  }

  turnComplete(turnId: string, extra: Record<string, unknown> = {}): this {
    return this.event({
      type: "task_complete",
      turn_id: turnId,
      last_agent_message: null,
      started_at: this.seconds() - 30,
      completed_at: this.seconds(),
      duration_ms: 30_000,
      ...extra,
    });
  }

  item(
    threadId: string,
    turnId: string,
    item: Record<string, unknown>,
    options: {
      startedAtMs?: number | null;
      completedAtMs?: number | null;
    } & RolloutLineOptions = {},
  ): this {
    const startedAtMs = options.startedAtMs === undefined ? this.millis() : options.startedAtMs;
    const completedAtMs =
      options.completedAtMs === undefined ? this.millis() + 500 : options.completedAtMs;
    return this.event(
      {
        type: "item_completed",
        thread_id: threadId,
        turn_id: turnId,
        item,
        ...(startedAtMs === null ? {} : { started_at_ms: startedAtMs }),
        ...(completedAtMs === null ? {} : { completed_at_ms: completedAtMs }),
      },
      options,
    );
  }

  text(): string {
    return this.chunks.join("");
  }
}

function sessionMeta(
  threadId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: threadId,
    id: threadId,
    timestamp: "2026-10-20T03:04:05.000Z",
    cwd: "C:\\fixture\\repo",
    originator: "paseo_fixture",
    cli_version: "0.167.0",
    source: "vscode",
    model_provider: "openai",
    base_instructions: null,
    history_mode: "paginated",
    ...extra,
  };
}

function userMessage(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "UserMessage",
    id,
    content: [{ type: "text", text, text_elements: [] }],
    ...extra,
  };
}

function agentMessage(id: string, text: string, phase: "commentary" | "final_answer") {
  return { type: "AgentMessage", id, content: [{ type: "Text", text }], phase };
}

function command(
  id: string,
  argv: string[],
  output: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "CommandExecution",
    id,
    process_id: "4242",
    command: argv,
    cwd: "file:///C:/fixture/repo",
    parsed_cmd: [{ type: "unknown", cmd: argv.join(" ") }],
    source: "unified_exec_startup",
    status: "completed",
    aggregated_output: output,
    exit_code: 0,
    duration: { secs: 1, nanos: 250_000_000 },
    ...extra,
  };
}

interface RootRollout {
  builder: RolloutBuilder;
  /** Start of turn r3, where the rewind fork cuts the parent. */
  rewindCut: { ordinal: number; byteOffset: number };
  /** Inside turn r2, after its image items, where the mid-turn fork cuts the parent. */
  midTurnCut: { ordinal: number; byteOffset: number };
}

function buildRootRollout(): RootRollout {
  const root = ROLLOUT_FIXTURE_THREADS.root;
  const [r1, r2, r3, r4, r5, r6] = ROLLOUT_FIXTURE_TURNS.root;
  const b = new RolloutBuilder(0, BASE_MS);
  b.line("session_meta", sessionMeta(root));
  b.event({
    type: "thread_settings_applied",
    thread_id: root,
    thread_settings: { model: "gpt-fixture", model_provider_id: "openai" },
  });

  // Turn 1: ordinary conversation with commands, a patch and quoting that must survive replay.
  b.turnStarted(r1);
  b.line("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Fix the failing build" }],
  });
  b.item(
    root,
    r1,
    userMessage("item-r1-user", "Fix the failing build", {
      client_id: "client-message-1",
      content: [
        {
          type: "text",
          text: "Fix the failing build [image]",
          text_elements: [{ byte_range: { start: 22, end: 29 }, placeholder: "[image]" }],
        },
        { type: "local_image", path: "C:\\fixture\\repo\\screenshot.png" },
        { type: "image", image_url: `data:image/png;base64,${PNG_1X1}`, detail: "high" },
      ],
    }),
  );
  b.item(root, r1, {
    type: "Reasoning",
    id: "item-r1-reasoning",
    summary_text: ["Reading the build log", "Checking the config"],
    raw_content: [],
  });
  b.item(root, r1, agentMessage("item-r1-commentary", "Looking at the build first.", "commentary"));
  b.item(
    root,
    r1,
    command(
      "call-r1-grep",
      ["bash", "-lc", `grep -n "api_key = sk-abcdefghijklmnopqrstuvwx" src/app.ts && echo 'done'`],
      "src/app.ts:3:api_key\ndone\n",
      {
        parsed_cmd: [
          {
            type: "search",
            cmd: 'grep -n "api_key = sk-abcdefghijklmnopqrstuvwx" src/app.ts',
            query: "api_key = sk-abcdefghijklmnopqrstuvwx",
            path: "src/app.ts",
          },
          { type: "unknown", cmd: "echo 'done'" },
        ],
      },
    ),
  );
  b.item(
    root,
    r1,
    command(
      "call-r1-pwsh",
      [
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "-Command",
        "Get-ChildItem 'C:\\fixture\\repo' | Select-Object -First 2",
      ],
      "",
      {
        status: "failed",
        exit_code: 1,
        aggregated_output: "Access denied\n",
        parsed_cmd: [
          { type: "read", cmd: "type src\\b.ts", name: "b.ts", path: "src\\b.ts" },
          { type: "read", cmd: "type D:\\other\\c.ts", name: "c.ts", path: "D:\\other\\c.ts" },
          { type: "list_files", cmd: "Get-ChildItem", path: null },
        ],
      },
    ),
  );
  b.item(
    root,
    r1,
    command(
      "call-r1-curl",
      [
        "curl",
        "-H",
        "Authorization: Bearer abcdefghijklmnop0123456789",
        "https://example.test/a b?x=1&y=$HOME",
        "",
        "^caret",
        "naïve",
        "AKIAABCDEFGHIJKLMNOP",
        "--token=abcdefghij",
      ],
      "{}",
      {
        source: "agent",
        process_id: undefined,
        cwd: "file://fileserver/share/fixture%20repo",
        duration: { secs: 0, nanos: 5_000_000 },
      },
    ),
  );
  b.item(
    root,
    r1,
    command("call-r1-cat", ["cat", "../lib/x.ts"], "", {
      cwd: "file:///home/fixture/repo/",
      parsed_cmd: [
        { type: "read", cmd: "cat ../lib/x.ts", name: "x.ts", path: "../lib/x.ts" },
        { type: "list_files", cmd: "ls src", path: "src" },
        { type: "search", cmd: "rg secret", query: null, path: null },
      ],
    }),
  );
  b.item(root, r1, {
    type: "FileChange",
    id: "call-r1-patch",
    changes: {
      "C:\\fixture\\repo\\src\\b.ts": {
        type: "update",
        unified_diff: "@@ -1 +1 @@\n-old\n+new\n",
        move_path: "C:\\fixture\\repo\\src\\c.ts",
      },
      "C:\\fixture\\repo\\src\\a.ts": {
        type: "update",
        unified_diff: "@@ -1 +1 @@\n-a\n+b\n",
        move_path: null,
      },
      "C:\\fixture\\repo\\src\\new.ts": { type: "add", content: "export const x = 1;\n" },
      "C:\\fixture\\repo\\src\\gone.ts": { type: "delete", content: "old\n" },
    },
    status: "completed",
    stdout: "Success.",
  });
  b.item(root, r1, agentMessage("item-r1-final", "The build passes now.", "final_answer"));
  b.turnComplete(r1, { last_agent_message: "The build passes now." });

  // Turn 2: images from every source Codex records, and MCP results with an image.
  b.turnStarted(r2);
  b.item(root, r2, userMessage("item-r2-user", "Show me the screenshots"));
  b.item(root, r2, {
    type: "ImageView",
    id: "call-r2-view",
    path: "file:///C:/fixture/repo/shot%20one.png",
  });
  b.item(root, r2, {
    type: "McpToolCall",
    id: "call-r2-mcp",
    server: "node_repl",
    tool: "js",
    arguments: { code: "render()", title: "render" },
    status: "completed",
    result: {
      content: [
        { type: "text", text: "rendered" },
        { type: "image", data: PNG_1X1, mimeType: "image/png" },
      ],
      isError: false,
    },
    duration: { secs: 0, nanos: 20_000_000 },
    readOnlyHint: true,
  });
  const midTurnCut = { ordinal: b.nextOrdinal, byteOffset: b.byteLength };
  b.item(root, r2, {
    type: "McpToolCall",
    id: "call-r2-mcp-failed",
    server: "node_repl",
    tool: "js",
    arguments: { code: "throw new Error()" },
    status: "failed",
    error: { message: "tool crashed" },
    duration: { secs: 0, nanos: 1_000_000 },
  });
  b.item(root, r2, {
    type: "Extension",
    kind: "web.search",
    id: "call-r2-search",
    query: "codex rollout format",
    action: { type: "search", query: "codex rollout format", queries: null },
    results: [{ title: "Rollouts", url: "https://example.test/rollouts" }],
  });
  b.item(root, r2, {
    type: "WebSearch",
    id: "call-r2-open",
    query: "",
    action: { type: "open_page", url: "https://example.test/page" },
  });
  b.item(root, r2, {
    type: "Extension",
    kind: "clock.sleep",
    id: "call-r2-sleep",
    durationMs: 1500,
  });
  b.item(root, r2, {
    type: "Extension",
    kind: "image_gen.generation",
    id: "call-r2-imagegen",
    status: "completed",
    revisedPrompt: "a blue square",
    result: PNG_1X1,
  });
  b.item(root, r2, {
    type: "ImageGeneration",
    id: "call-r2-imagegen-hosted",
    status: "failed",
    revised_prompt: "a red circle",
    result: "",
  });
  b.item(root, r2, agentMessage("item-r2-final", "Here they are.", "final_answer"));
  b.turnComplete(r2);

  // Turn 3: a sub-agent with its own nested sub-agent.
  const rewindCut = { ordinal: b.nextOrdinal, byteOffset: b.byteLength };
  b.turnStarted(r3);
  b.item(root, r3, userMessage("item-r3-user", "Ask a helper to investigate"));
  b.item(root, r3, {
    type: "CollabAgentToolCall",
    id: "call-r3-spawn",
    tool: "spawn_agent",
    status: "completed",
    sender_thread_id: root,
    receiver_thread_ids: [ROLLOUT_FIXTURE_THREADS.child],
    receiver_agents: [],
    prompt: "Investigate the flaky test",
    model: "gpt-fixture",
    reasoning_effort: "high",
    agents_states: { [ROLLOUT_FIXTURE_THREADS.child]: { completed: "Found it" } },
  });
  b.item(root, r3, {
    type: "SubAgentActivity",
    id: "activity-r3-started",
    kind: "started",
    agent_thread_id: ROLLOUT_FIXTURE_THREADS.child,
    agent_path: "/root/helper",
    model: "gpt-fixture",
    reasoning_effort: "high",
  });
  b.item(root, r3, {
    type: "SubAgentActivity",
    id: "activity-r3-interacted",
    kind: "interacted",
    agent_thread_id: ROLLOUT_FIXTURE_THREADS.child,
    agent_path: "/root/helper",
    model: null,
    reasoning_effort: null,
  });
  b.item(root, r3, {
    type: "CollabAgentToolCall",
    id: "call-r3-wait",
    tool: "wait",
    status: "completed",
    sender_thread_id: root,
    receiver_thread_ids: [ROLLOUT_FIXTURE_THREADS.child],
    receiver_agents: [],
    agents_states: {},
  });
  b.item(root, r3, {
    type: "SubAgentActivity",
    id: "activity-r3-completed",
    kind: "completed",
    agent_thread_id: ROLLOUT_FIXTURE_THREADS.child,
    agent_path: "/root/helper",
  });
  b.item(root, r3, agentMessage("item-r3-final", "The helper found the flake.", "final_answer"));
  b.turnComplete(r3);

  // Turn 4: compaction, a plan, an async question and items Paseo does not render.
  b.turnStarted(r4);
  b.item(root, r4, userMessage("item-r4-user", "Keep going"));
  b.line("compacted", { message: "Summary of earlier work", replacement_history: [] });
  b.item(root, r4, { type: "ContextCompaction", id: "item-r4-compaction" });
  b.item(root, r4, { type: "Plan", id: "item-r4-plan", text: "1. Reproduce\n2. Fix  \n3. Verify" });
  b.item(root, r4, {
    type: "AgentMessage",
    id: "item-r4-question",
    content: [{ type: "Text", text: "Which branch should I use?" }],
    phase: "commentary",
    delivery: "async",
    questions: [{ title: "Which branch should I use?", options: ["main", "release"] }],
  });
  b.item(root, r4, {
    type: "DynamicToolCall",
    id: "call-r4-dynamic",
    tool: "lookup",
    arguments: { key: "value" },
    status: "completed",
    content_items: [{ type: "inputText", text: "ok" }],
    success: true,
    duration: { secs: 0, nanos: 3_000_000 },
  });
  b.item(root, r4, {
    type: "HookPrompt",
    id: "item-r4-hook",
    fragments: [{ text: "Remember the style guide", hookRunId: "hook-run-1" }],
  });
  b.item(root, r4, {
    type: "Reasoning",
    id: "item-r4-raw-reasoning",
    summary_text: [],
    raw_content: ["raw thought"],
  });
  b.item(root, r4, { type: "Reasoning", id: "item-r4-empty-reasoning", summary_text: [] });
  b.turnComplete(r4, {
    error: { message: "Usage limit reached", codex_error_info: "usage_limit_exceeded" },
  });

  // Turn 5: interrupted by the user.
  b.turnStarted(r5);
  b.item(root, r5, userMessage("item-r5-user", "Actually, stop"));
  b.item(root, r5, agentMessage("item-r5-commentary", "Stopping.", "commentary"));
  b.event({
    type: "turn_aborted",
    turn_id: r5,
    reason: "interrupted",
    started_at: b.seconds() - 5,
    completed_at: b.seconds(),
    duration_ms: 5000,
  });

  // Turn 6: records Codex skips or merges while projecting.
  b.turnStarted(r6);
  b.item(root, r6, userMessage("item-r6-user", "Final check"), { startedAtMs: null });
  b.item(root, r6, agentMessage("item-r6-draft", "First draft", "commentary"));
  b.raw("{this is not json\n");
  b.event({ type: "token_count", info: null, rate_limits: null }, { ordinal: null });
  b.item(root, r6, agentMessage("item-r6-duplicate-ordinal", "Never shown", "commentary"), {
    ordinal: b.nextOrdinal - 1,
  });
  b.item(root, r6, agentMessage("item-r6-draft", "Second draft replaces the first", "commentary"));
  b.item(root, r6, agentMessage("item-r6-final", "All checks pass.", "final_answer"));
  b.turnComplete(r6);
  b.item(root, r6, command("call-r6-late", ["echo", "late"], "late\n"));
  // A record still being written when the file was read.
  b.raw(
    JSON.stringify({
      timestamp: b.timestamp(),
      ordinal: b.nextOrdinal,
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: r6,
        item: agentMessage("x", "partial", "commentary"),
      },
    }).slice(0, 80),
  );
  return { builder: b, rewindCut, midTurnCut };
}

function buildChildRollout(): RolloutBuilder {
  const child = ROLLOUT_FIXTURE_THREADS.child;
  const b = new RolloutBuilder(0, BASE_MS + 60_000);
  b.line(
    "session_meta",
    sessionMeta(child, {
      parent_thread_id: ROLLOUT_FIXTURE_THREADS.root,
      agent_nickname: "helper",
      agent_path: "/root/helper",
      subagent_history_start_ordinal: 4,
    }),
  );
  // History copied from the parent when the sub-agent started; replay must skip it.
  b.turnStarted("turn-r1");
  b.item(child, "turn-r1", userMessage("item-r1-user", "Fix the failing build"));
  b.item(child, "turn-r1", agentMessage("item-r1-final", "The build passes now.", "final_answer"));
  b.turnStarted("turn-c1");
  b.item(child, "turn-c1", userMessage("item-c1-user", "Investigate the flaky test"));
  b.item(child, "turn-c1", {
    type: "Reasoning",
    id: "item-c1-reasoning",
    summary_text: ["Running it in a loop"],
    raw_content: [],
  });
  b.item(
    child,
    "turn-c1",
    command("call-c1-loop", ["bash", "-lc", "for i in 1 2 3; do npm test; done"], "ok\n"),
  );
  b.item(child, "turn-c1", {
    type: "CollabAgentToolCall",
    id: "call-c1-spawn",
    tool: "spawn_agent",
    status: "completed",
    sender_thread_id: child,
    receiver_thread_ids: [ROLLOUT_FIXTURE_THREADS.grandchild],
    receiver_agents: [],
    prompt: "Check the timer mocks",
    agents_states: {},
  });
  b.item(child, "turn-c1", {
    type: "SubAgentActivity",
    id: "activity-c1-started",
    kind: "started",
    agent_thread_id: ROLLOUT_FIXTURE_THREADS.grandchild,
    agent_path: "/root/helper/timers",
  });
  b.item(child, "turn-c1", agentMessage("item-c1-final", "Found it", "final_answer"));
  b.turnComplete("turn-c1");
  return b;
}

function buildGrandchildRollout(): RolloutBuilder {
  const grandchild = ROLLOUT_FIXTURE_THREADS.grandchild;
  const b = new RolloutBuilder(0, BASE_MS + 90_000);
  b.line(
    "session_meta",
    sessionMeta(grandchild, {
      parent_thread_id: ROLLOUT_FIXTURE_THREADS.child,
      agent_path: "/root/helper/timers",
    }),
  );
  b.turnStarted("turn-g1");
  b.item(grandchild, "turn-g1", userMessage("item-g1-user", "Check the timer mocks"));
  b.item(grandchild, "turn-g1", agentMessage("item-g1-final", "Timers are fine.", "final_answer"));
  b.turnComplete("turn-g1");
  return b;
}

function buildForkRollout(cut: { ordinal: number; byteOffset: number }): RolloutBuilder {
  const fork = ROLLOUT_FIXTURE_THREADS.fork;
  const b = new RolloutBuilder(cut.ordinal, BASE_MS + 3_600_000);
  b.line(
    "session_meta",
    sessionMeta(fork, {
      forked_from_id: ROLLOUT_FIXTURE_THREADS.root,
      history_base: {
        thread_id: ROLLOUT_FIXTURE_THREADS.root,
        end_ordinal_exclusive: cut.ordinal,
        end_byte_offset: cut.byteOffset,
      },
    }),
  );
  const [f1] = ROLLOUT_FIXTURE_TURNS.fork;
  b.turnStarted(f1);
  b.item(fork, f1, userMessage("item-f1-user", "Try a different approach"));
  b.item(fork, f1, agentMessage("item-f1-final", "Done differently.", "final_answer"));
  b.turnComplete(f1);
  return b;
}

function buildMidForkRollout(cut: { ordinal: number; byteOffset: number }): RolloutBuilder {
  const midFork = ROLLOUT_FIXTURE_THREADS.midFork;
  const b = new RolloutBuilder(cut.ordinal, BASE_MS + 3_700_000);
  b.line(
    "session_meta",
    sessionMeta(midFork, {
      forked_from_id: ROLLOUT_FIXTURE_THREADS.root,
      history_base: {
        thread_id: ROLLOUT_FIXTURE_THREADS.root,
        end_ordinal_exclusive: cut.ordinal,
        end_byte_offset: cut.byteOffset,
      },
    }),
  );
  b.event({ type: "turn_aborted", turn_id: "turn-r2", reason: "interrupted" });
  const [m1] = ROLLOUT_FIXTURE_TURNS.midFork;
  b.turnStarted(m1);
  b.item(midFork, m1, userMessage("item-m1-user", "Branch from the middle"));
  b.item(midFork, m1, agentMessage("item-m1-final", "Branched.", "final_answer"));
  b.turnComplete(m1);
  return b;
}

function buildCompressedRollout(): RolloutBuilder {
  const thread = ROLLOUT_FIXTURE_THREADS.compressed;
  const b = new RolloutBuilder(0, BASE_MS + 86_400_000);
  b.line("session_meta", sessionMeta(thread));
  b.turnStarted("turn-z1");
  b.item(thread, "turn-z1", userMessage("item-z1-user", "Compressed hello"));
  b.item(thread, "turn-z1", agentMessage("item-z1-final", "Compressed reply", "final_answer"));
  b.turnComplete("turn-z1");
  return b;
}

function buildLiveRollout(): RolloutBuilder {
  const thread = ROLLOUT_FIXTURE_THREADS.live;
  const b = new RolloutBuilder(0, BASE_MS + 2 * 86_400_000);
  b.line("session_meta", sessionMeta(thread));
  b.turnStarted("turn-l1");
  b.item(thread, "turn-l1", userMessage("item-l1-user", "First question"));
  b.item(thread, "turn-l1", agentMessage("item-l1-final", "First answer", "final_answer"));
  b.turnComplete("turn-l1");
  b.turnStarted("turn-l2");
  b.item(thread, "turn-l2", userMessage("item-l2-user", "Still running"));
  b.item(thread, "turn-l2", command("call-l2-build", ["npm", "run", "build"], "building\n"));
  // A complete record whose newline is not written yet does not count either.
  b.raw(
    JSON.stringify({
      timestamp: b.timestamp(),
      ordinal: b.nextOrdinal,
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: thread,
        turn_id: "turn-l2",
        item: agentMessage("item-l2-unterminated", "Not on disk yet", "commentary"),
        completed_at_ms: b.millis(),
      },
    }),
  );
  return b;
}

function writeRollout(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text);
}

export interface RolloutFixture {
  threads: typeof ROLLOUT_FIXTURE_THREADS;
  /** False on a Node.js without zstd, where the compressed rollout is not written. */
  compressed: boolean;
}

/** Writes every fixture rollout under `codexHome`. */
export function writeCodexRolloutFixture(codexHome: string): RolloutFixture {
  const root = buildRootRollout();
  const t = ROLLOUT_FIXTURE_THREADS;
  writeRollout(fixtureRolloutPath(codexHome, t.root), root.builder.text());
  writeRollout(fixtureRolloutPath(codexHome, t.child), buildChildRollout().text());
  writeRollout(fixtureRolloutPath(codexHome, t.grandchild), buildGrandchildRollout().text());
  writeRollout(fixtureRolloutPath(codexHome, t.fork), buildForkRollout(root.rewindCut).text());
  writeRollout(
    fixtureRolloutPath(codexHome, t.midFork),
    buildMidForkRollout(root.midTurnCut).text(),
  );
  const compressed = zstdCompress(Buffer.from(buildCompressedRollout().text()));
  if (compressed) {
    const compressedPath = fixtureRolloutPath(codexHome, t.compressed, true);
    mkdirSync(path.dirname(compressedPath), { recursive: true });
    writeFileSync(compressedPath, compressed);
  }
  writeRollout(fixtureRolloutPath(codexHome, t.live), buildLiveRollout().text());
  return { threads: t, compressed: compressed !== null };
}
