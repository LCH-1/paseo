import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "pino";
import { z } from "zod";

import { terminateWithTreeKill } from "../../../../utils/tree-kill.js";

const DEFAULT_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const APP_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;
const APP_SERVER_STDOUT_DRAIN_TIMEOUT_MS = 1_000;
const STDERR_BUFFER_LIMIT = 8192;

interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { message?: string; code?: string | number; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexAppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code: string | number | undefined,
    readonly data: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

type RequestHandler = (params: unknown, requestId: number) => unknown;
type NotificationHandler = (method: string, params: unknown) => void;
type UnexpectedTerminationHandler = (error: Error) => void;

export interface CodexThreadForkParams {
  threadId: string;
  beforeTurnId?: string | null;
  path?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandbox?: unknown;
  permissions?: string | null;
  config?: Record<string, unknown> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean;
  threadSource?: unknown;
  excludeTurns?: boolean;
  persistExtendedHistory?: boolean;
}

const CodexThreadForkResponseSchema = z
  .object({
    thread: z
      .object({
        id: z.string(),
        sessionId: z.string().optional(),
        forkedFromId: z.string().nullable().optional(),
        turns: z.array(z.unknown()).optional(),
      })
      .passthrough(),
    model: z.string(),
    modelProvider: z.string(),
    serviceTier: z.string().nullable(),
    cwd: z.string(),
    runtimeWorkspaceRoots: z.array(z.string()).optional().default([]),
    instructionSources: z.array(z.string()).optional().default([]),
    approvalPolicy: z.unknown(),
    approvalsReviewer: z.unknown(),
    sandbox: z.unknown(),
    activePermissionProfile: z.unknown().optional(),
    reasoningEffort: z.string().nullable().optional(),
  })
  .passthrough();

export type CodexThreadForkResponse = z.infer<typeof CodexThreadForkResponseSchema>;

export function parseCodexThreadForkResponse(response: unknown): CodexThreadForkResponse {
  return CodexThreadForkResponseSchema.parse(response);
}

export interface CodexThreadRollbackParams {
  threadId: string;
  numTurns: number;
}

const CodexThreadRollbackResponseSchema = z
  .object({
    thread: z
      .object({
        id: z.string(),
        sessionId: z.string().optional(),
        forkedFromId: z.string().nullable().optional(),
        turns: z.array(z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type CodexThreadRollbackResponse = z.infer<typeof CodexThreadRollbackResponseSchema>;

export function parseCodexThreadRollbackResponse(response: unknown): CodexThreadRollbackResponse {
  return CodexThreadRollbackResponseSchema.parse(response);
}

export interface CodexAppServerTraceContext {
  agentId?: string;
  sessionId?: string;
  turnId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  if (!isRecord(msg)) return false;
  return typeof msg.id === "number";
}

function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  if (!isRecord(msg)) return false;
  return typeof msg.id === "number" && typeof msg.method === "string";
}

function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  if (!isRecord(msg)) return false;
  return typeof msg.method === "string" && msg.id === undefined;
}

function readProviderSessionId(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  return typeof params.threadId === "string" ? params.threadId : undefined;
}

function readProviderTurnId(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  if (typeof params.turnId === "string") {
    return params.turnId;
  }
  const turn = params.turn;
  return isRecord(turn) && typeof turn.id === "string" ? turn.id : undefined;
}

/**
 * Splits stdout into lines on "\n" only. `node:readline` additionally treats U+2028 and U+2029
 * as line terminators, but Codex emits those characters raw inside JSON strings, so readline
 * would cut a single JSON-RPC message into pieces that fail to parse.
 */
function createNewlineLineReader(
  input: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): { close(): void } {
  const decoder = new StringDecoder("utf8");
  // Text after the last "\n", kept as parts and joined once its line ends, so a large line
  // arriving in many chunks is scanned and copied once instead of once per chunk.
  let unterminated: string[] = [];
  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let lineStart = 0;
    let index = text.indexOf("\n");
    while (index !== -1) {
      unterminated.push(text.slice(lineStart, index));
      const line = unterminated.join("");
      unterminated = [];
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      lineStart = index + 1;
      index = text.indexOf("\n", lineStart);
    }
    if (lineStart < text.length) {
      unterminated.push(text.slice(lineStart));
    }
  };
  const onEnd = (): void => {
    unterminated.push(decoder.end());
    const line = unterminated.join("");
    unterminated = [];
    if (line) {
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  };
  input.on("data", onData);
  input.on("end", onEnd);
  return {
    close: () => {
      input.off("data", onData);
      input.off("end", onEnd);
    },
  };
}

export class CodexAppServerClient {
  private readonly stdoutLineReader: { close(): void };
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private notificationHandler: NotificationHandler | null = null;
  private unexpectedTerminationHandler: UnexpectedTerminationHandler | null = null;
  private nextId = 1;
  private disposed = false;
  private stderrBuffer = "";
  private processExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private stdoutDrainTimer: NodeJS.Timeout | null = null;
  private resolveTermination!: () => void;
  private readonly terminationPromise = new Promise<void>((resolve) => {
    this.resolveTermination = resolve;
  });

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly logger: Logger,
    private readonly getTraceContext: () => CodexAppServerTraceContext = () => ({}),
  ) {
    this.stdoutLineReader = createNewlineLineReader(child.stdout, (line) => {
      void this.handleLine(line).catch((error) => {
        this.logger.warn({ error, line }, "Failed to handle Codex app-server stdout line");
      });
    });

    child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
      }
    });

    child.on("error", (err) => {
      this.logger.error({ err }, "Codex app-server child process error");
      this.handleUnexpectedTermination(err);
    });

    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      // Pipe errors are emitted by the stream, not ChildProcess. Keep these
      // listeners after disposal too, since an in-flight write may fail later.
      stream.on("error", (error) => this.handleUnexpectedTermination(error));
    }
    const onStdoutClosed = (): void => {
      this.handleUnexpectedTermination(
        this.processExit
          ? this.createExitError()
          : new Error("Codex app-server stdout closed before the process exited"),
      );
    };
    child.stdout.on("end", onStdoutClosed);
    child.stdout.on("close", onStdoutClosed);

    child.on("exit", (code, signal) => {
      this.processExit = { code, signal };
      if (this.disposed || this.stdoutDrainTimer) {
        return;
      }
      // `exit` can precede the final stdout data. Prefer EOF/close so the last
      // response or turn/completed is delivered before termination, but bound
      // the wait when an inherited pipe remains open in a wrapper descendant.
      this.stdoutDrainTimer = setTimeout(() => {
        this.handleUnexpectedTermination(this.createExitError());
      }, APP_SERVER_STDOUT_DRAIN_TIMEOUT_MS);
      this.stdoutDrainTimer.unref();
    });
    child.on("close", (code, signal) => {
      this.processExit ??= { code, signal };
      this.handleUnexpectedTermination(this.createExitError());
    });
  }

  setUnexpectedTerminationHandler(handler: UnexpectedTerminationHandler): void {
    this.unexpectedTerminationHandler = handler;
  }

  get isClosed(): boolean {
    return this.disposed || this.processExit !== null;
  }

  waitForTermination(): Promise<void> {
    return this.terminationPromise;
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("Codex app-server client is closed"));
    }
    if (this.processExit) {
      return Promise.reject(this.createExitError());
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = { id, method, params };
    const serialized = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(`${serialized}\n`);
    });
  }

  async forkThread(params: CodexThreadForkParams): Promise<CodexThreadForkResponse> {
    return parseCodexThreadForkResponse(await this.request("thread/fork", params));
  }

  async rollbackThread(params: CodexThreadRollbackParams): Promise<CodexThreadRollbackResponse> {
    return parseCodexThreadRollbackResponse(await this.request("thread/rollback", params));
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) {
      return;
    }
    const payload: JsonRpcNotification = { method, params };
    this.write(`${JSON.stringify(payload)}\n`);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearStdoutDrainTimer();
    this.resolveTermination();
    this.unexpectedTerminationHandler = null;
    this.stdoutLineReader.close();
    this.rejectPending(new Error("Codex app-server client is closed"));
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    const result = await terminateWithTreeKill(this.child, {
      gracefulTimeoutMs: APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: APP_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.logger.warn(
          { timeoutMs: APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          "Codex app-server did not exit after SIGTERM; sending SIGKILL",
        );
      },
    });
    if (result === "kill-timeout") {
      throw new Error("Codex app-server did not report exit after SIGKILL");
    }
  }

  private handleUnexpectedTermination(error: Error): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearStdoutDrainTimer();
    this.resolveTermination();
    this.stdoutLineReader.close();
    this.rejectPending(error);
    const handler = this.unexpectedTerminationHandler;
    this.unexpectedTerminationHandler = null;
    if (!handler) {
      return;
    }
    try {
      handler(error);
    } catch (handlerError) {
      this.logger.warn({ err: handlerError }, "Codex app-server termination handler threw");
    }
  }

  private createExitError(): Error {
    const { code, signal } = this.processExit ?? { code: null, signal: null };
    const message =
      code === 0 && !signal
        ? "Codex app-server exited"
        : `Codex app-server exited with code ${code ?? "null"} and signal ${signal ?? "null"}`;
    return new Error(`${message}\n${this.stderrBuffer}`.trim());
  }

  private clearStdoutDrainTimer(): void {
    if (this.stdoutDrainTimer) {
      clearTimeout(this.stdoutDrainTimer);
      this.stdoutDrainTimer = null;
    }
  }

  private write(message: string): void {
    if (this.isClosed) {
      return;
    }
    if (
      this.child.stdin.destroyed ||
      !this.child.stdin.writable ||
      this.child.stdin.writableEnded
    ) {
      this.handleUnexpectedTermination(new Error("Codex app-server stdin is closed"));
      return;
    }
    try {
      this.child.stdin.write(message);
    } catch (error) {
      this.handleUnexpectedTermination(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private writeJsonRpcResponse(response: JsonRpcResponse): void {
    this.write(`${JSON.stringify(response)}\n`);
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      this.logger.warn({ error, line }, "Ignoring non-JSON Codex app-server stdout line");
      return;
    }

    if (!isRecord(raw)) {
      this.logger.warn({ line }, "Parsed JSON is not an object");
      return;
    }

    if (isJsonRpcResponse(raw)) {
      const id = raw.id;
      if (raw.result !== undefined || raw.error) {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (raw.error) {
          pending.reject(
            new CodexAppServerRpcError(
              raw.error.message ?? "Unknown error",
              raw.error.code,
              raw.error.data,
            ),
          );
        } else {
          pending.resolve(raw.result);
        }
        return;
      }

      if (isJsonRpcRequest(raw)) {
        const request = raw;
        this.traceRawEvent(request);
        const handler = this.requestHandlers.get(request.method);
        try {
          const result = handler ? await handler(request.params, request.id) : {};
          this.writeJsonRpcResponse({ id: request.id, result });
        } catch (error) {
          this.writeJsonRpcResponse({
            id: request.id,
            error: { message: error instanceof Error ? error.message : String(error) },
          });
        }
        return;
      }
    }

    if (isJsonRpcNotification(raw)) {
      this.traceRawEvent(raw);
      this.notificationHandler?.(raw.method, raw.params);
    }
  }

  private traceRawEvent(raw: JsonRpcRequest | JsonRpcNotification): void {
    const traceContext = this.getTraceContext();
    this.logger.trace(
      {
        provider: "codex",
        agentId: traceContext.agentId,
        sessionId: traceContext.sessionId ?? readProviderSessionId(raw.params),
        turnId: traceContext.turnId ?? readProviderTurnId(raw.params),
        method: raw.method,
        params: raw.params,
        rawEvent: raw,
      },
      "provider.codex.raw_event",
    );
  }
}
