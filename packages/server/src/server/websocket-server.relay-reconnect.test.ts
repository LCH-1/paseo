import { SessionDelivery } from "./session/owned-subscriptions/index.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Server as HTTPServer } from "http";
import pino from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { ScheduleService } from "./schedule/service.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import {
  asUint8Array,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
} from "@getpaseo/protocol/terminal-stream-protocol";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { APPLICATION_SOCKET_LEASE_MS } from "./websocket/physical-socket.js";

type SocketListener = (...args: unknown[]) => void;

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    static instances: MockWebSocketServer[] = [];
    readonly handlers = new Map<string, (...args: unknown[]) => void>();

    constructor(_options: unknown) {
      MockWebSocketServer.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      // no-op
    }
  }

  return { MockWebSocketServer };
});

const sessionMock = vi.hoisted(() => {
  const instances: MockSession[] = [];

  class MockSession {
    readonly delivery = new SessionDelivery((source, message) => {
      const send = this.args.onMessageToSource as (source: object, message: unknown) => void;
      send(source, message);
    });
    cleanup = vi.fn(async () => {
      await this.delivery.close();
    });
    handleMessage = vi.fn(async () => {});
    handleBinaryFrame = vi.fn((_frame: unknown) => {});
    supports = vi.fn((capability: string) => this.args.clientCapabilities?.[capability] === true);
    updateClientCapabilities = vi.fn(
      (capabilities: Record<string, unknown> | null, source: object) => {
        this.args.clientCapabilities = capabilities;
        this.delivery.attach(source, capabilities?.owned_subscriptions === true);
      },
    );
    clearAgentTimelineSubscription = vi.fn((source: object) => {
      void this.delivery.detach(source);
    });
    getClientActivity = vi.fn(() => null);
    wantsSourceEvent = (source: object) => !this.delivery.isModern(source);
    getSessionId = vi.fn(() => "mock-session-id");
    getPermissions = vi.fn(() => this.args.permissions as string[]);
    allowsInbound = vi.fn(() => true);
    allowsPermission = vi.fn(() => true);
    publish = vi.fn((message: unknown) => {
      const onMessage = this.args.onMessage as ((message: unknown) => void) | undefined;
      onMessage?.(message);
    });
    resetPeakInflight = vi.fn(() => {});
    getRuntimeMetrics = vi.fn(() => ({
      checkoutDiffTargetCount: 0,
      checkoutDiffSubscriptionCount: 0,
      checkoutDiffWatcherCount: 0,
      checkoutDiffFallbackRefreshTargetCount: 0,
      terminalDirectorySubscriptionCount: 0,
      terminalSubscriptionCount: 0,
      inflightRequests: 0,
      peakInflightRequests: 0,
    }));
    readonly args: Record<string, unknown>;

    constructor(args: Record<string, unknown>) {
      this.args = args;
      instances.push(this);
    }
  }

  return { MockSession, instances };
});

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

vi.mock("./session.js", () => ({
  Session: sessionMock.MockSession,
}));

vi.mock("./push/index.js", () => ({
  createPushNotifications: () => ({
    renew: () => undefined,
    revoke: () => undefined,
    send: async () => undefined,
  }),
}));

import { z } from "zod";
import { VoiceAssistantWebSocketServer } from "./websocket-server";
import { DAEMON_PERMISSIONS, parseServerInfoStatusPayload } from "./messages.js";
import type { SpeechReadinessSnapshot } from "./speech/speech-runtime.js";

interface WebSocketServerInternals {
  attachSocket(ws: unknown, req: unknown): Promise<void>;
}

const TEST_DAEMON_VERSION = "1.2.3-test";

const WireEnvelopeSchema = z.object({
  type: z.string().optional(),
  message: z
    .object({
      type: z.string().optional(),
      payload: z.unknown().optional(),
    })
    .optional(),
});

function parseSentEnvelope(data: unknown): z.infer<typeof WireEnvelopeSchema> {
  if (typeof data !== "string") throw new Error("Expected string frame");
  return WireEnvelopeSchema.parse(JSON.parse(data));
}

function sentEnvelopes(socket: MockSocket): z.infer<typeof WireEnvelopeSchema>[] {
  return socket.sent.filter((data) => typeof data === "string").map(parseSentEnvelope);
}

function sentServerInfoEnvelopes(socket: MockSocket): z.infer<typeof WireEnvelopeSchema>[] {
  return sentEnvelopes(socket).filter(
    (envelope) => parseServerInfoStatusPayload(envelope.message?.payload) !== null,
  );
}

function sentBinaryFrames(socket: MockSocket): Uint8Array[] {
  return socket.sent.map(asUint8Array).filter((frame): frame is Uint8Array => frame !== null);
}

function sentTerminalFrames(
  socket: MockSocket,
): NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>[] {
  return sentBinaryFrames(socket)
    .map(decodeTerminalStreamFrame)
    .filter(
      (frame): frame is NonNullable<ReturnType<typeof decodeTerminalStreamFrame>> => frame !== null,
    );
}

const BinaryFrameSchema = z.object({
  kind: z.literal("terminal"),
  frame: z.object({
    opcode: z.number(),
    slot: z.number(),
    payload: z.instanceof(Uint8Array),
  }),
});

class MockSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  private listeners = new Map<string, SocketListener[]>();

  on(event: "message" | "close" | "error", listener: SocketListener): void {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(listener);
    this.listeners.set(event, handlers);
  }

  once(event: "close" | "error", listener: SocketListener): void {
    const wrapped: SocketListener = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    this.on(event, wrapped);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit("close", code ?? 1000, reason ?? "");
  }

  emit(event: "message" | "close" | "error", ...args: unknown[]): void {
    const handlers = this.listeners.get(event) ?? [];
    for (const handler of handlers.slice()) {
      handler(...args);
    }
  }

  private off(event: "close" | "error", listener: SocketListener): void {
    const handlers = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      handlers.filter((handler) => handler !== listener),
    );
  }
}

function createLogger() {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

interface CapturedLogLine {
  level: number;
  msg: string;
  [field: string]: unknown;
}

// Socket identity lives in child-logger bindings, so assertions on it need pino's real output.
function createCapturingLog(): { log: pino.Logger; lines: CapturedLogLine[]; raw: string[] } {
  const lines: CapturedLogLine[] = [];
  const raw: string[] = [];
  const log = pino(
    { level: "debug" },
    {
      write(line: string) {
        raw.push(line);
        lines.push(JSON.parse(line));
      },
    },
  );
  return { log, lines, raw };
}

function linesWithMessage(lines: CapturedLogLine[], msg: string): CapturedLogLine[] {
  return lines.filter((line) => line.msg === msg);
}

function createWorkspaceAutoNameStub(): WorkspaceAutoName {
  return createStub<WorkspaceAutoName>({
    scheduleForWorktree: () => {},
    scheduleForDirectory: () => {},
  });
}

function createServer(options?: {
  speechReadiness?: SpeechReadinessSnapshot | null;
  logger?: ReturnType<typeof createLogger>;
  log?: pino.Logger;
  startPaused?: boolean;
  auth?: { password: string; localCredential: () => string | null };
}) {
  const speechReadiness = options?.speechReadiness ?? null;
  const daemonConfigStore = {
    onApply: vi.fn(() => () => {}),
    onChange: vi.fn(() => () => {}),
  };
  const logger = options?.logger ?? createLogger();
  return new VoiceAssistantWebSocketServer(
    createStub<HTTPServer>({}),
    options?.log ?? createStub<pino.Logger>(logger),
    "srv_test",
    createStub<AgentManager>({
      subscribe: vi.fn(() => () => {}),
      setAgentAttentionCallback: vi.fn(),
      getAgent: vi.fn(() => null),
      getMetricsSnapshot: vi.fn(() => ({
        totalAgents: 0,
        idleAgents: 0,
        runningAgents: 0,
        pendingPermissionAgents: 0,
        erroredAgents: 0,
      })),
    }),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    "/tmp/paseo-test",
    createStub<DaemonConfigStore>(daemonConfigStore),
    null,
    { allowedOrigins: new Set(), startPaused: options?.startPaused },
    createWorkspaceAutoNameStub(),
    options?.auth,
    speechReadiness
      ? {
          resolveStt: () => null,
          resolveSttLanguage: () => "en",
          resolveTts: () => null,
          resolveTurnDetection: () => null,
          resolveDictationStt: () => null,
          resolveDictationSttLanguage: () => "en",
          getReadiness: () => speechReadiness,
          onReadinessChange: vi.fn(() => () => {}),
          start: vi.fn(),
          stop: vi.fn(),
          ready: Promise.resolve(),
        }
      : undefined,
    undefined,
    undefined,
    TEST_DAEMON_VERSION,
    undefined,
    undefined,
    undefined,
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      })),
      dispose: vi.fn(),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createProviderSnapshotManagerStub().manager,
  );
}

function createReadySpeechReadinessSnapshot(): SpeechReadinessSnapshot {
  return {
    generatedAt: "2026-02-14T00:00:00.000Z",
    requiredLocalModelIds: [],
    missingLocalModelIds: [],
    download: {
      inProgress: false,
      error: null,
    },
    dictation: {
      enabled: true,
      available: true,
      reasonCode: "ready",
      message: "Dictation is ready.",
      retryable: false,
      missingModelIds: [],
    },
    realtimeVoice: {
      enabled: true,
      available: true,
      reasonCode: "ready",
      message: "Realtime voice is ready.",
      retryable: false,
      missingModelIds: [],
    },
    voiceFeature: {
      enabled: true,
      available: true,
      reasonCode: "ready",
      message: "Voice features are ready.",
      retryable: false,
      missingModelIds: [],
    },
  };
}

function createDownloadInProgressSpeechReadinessSnapshot(): SpeechReadinessSnapshot {
  return {
    generatedAt: "2026-02-14T00:00:00.000Z",
    requiredLocalModelIds: ["parakeet-tdt-0.6b-v2-int8"],
    missingLocalModelIds: ["parakeet-tdt-0.6b-v2-int8"],
    download: {
      inProgress: true,
      error: null,
    },
    dictation: {
      enabled: true,
      available: false,
      reasonCode: "stt_unavailable",
      message: "Dictation is unavailable: speech-to-text service is not ready.",
      retryable: false,
      missingModelIds: [],
    },
    realtimeVoice: {
      enabled: true,
      available: false,
      reasonCode: "stt_unavailable",
      message: "Realtime voice is unavailable: speech-to-text service is not ready.",
      retryable: false,
      missingModelIds: [],
    },
    voiceFeature: {
      enabled: true,
      available: false,
      reasonCode: "model_download_in_progress",
      message:
        "Voice features are unavailable while models download in the background (parakeet-tdt-0.6b-v2-int8).",
      retryable: true,
      missingModelIds: ["parakeet-tdt-0.6b-v2-int8"],
    },
  };
}

function createHelloMessage(
  clientId: string,
  options?: { capabilities?: Record<string, boolean> },
) {
  return {
    type: "hello" as const,
    clientId,
    clientType: "cli" as const,
    protocolVersion: 1,
    ...(options?.capabilities ? { capabilities: options.capabilities } : {}),
  };
}

function createDirectRequest() {
  return {
    headers: {
      host: "localhost:6767",
      origin: "http://localhost:6767",
      "user-agent": "vitest",
    },
    socket: {
      remoteAddress: "127.0.0.1",
    },
    url: "/ws",
  };
}

async function attachRelayAndHello(params: {
  server: VoiceAssistantWebSocketServer;
  socket: MockSocket;
  clientId: string;
}) {
  await params.server.attachExternalSocket(params.socket, { transport: "relay" });
  params.socket.emit("message", JSON.stringify(createHelloMessage(params.clientId)));
  await vi.waitFor(() => expect(params.socket.sent.length).toBeGreaterThan(0));
  const envelope = parseSentEnvelope(params.socket.sent[0]);
  expect(envelope.type).toBe("session");
  const serverInfo = parseServerInfoStatusPayload(envelope.message?.payload);
  expect(envelope.message?.type).toBe("status");
  expect(serverInfo).not.toBeNull();
  return serverInfo!;
}

async function attachDirectAndHello(params: {
  server: VoiceAssistantWebSocketServer;
  socket: MockSocket;
  clientId: string;
}) {
  await asInternals<WebSocketServerInternals>(params.server).attachSocket(
    params.socket,
    createDirectRequest(),
  );
  params.socket.emit("message", JSON.stringify(createHelloMessage(params.clientId)));
  await vi.waitFor(() => expect(params.socket.sent.length).toBeGreaterThan(0));
  const envelope = parseSentEnvelope(params.socket.sent[0]);
  expect(envelope.type).toBe("session");
  const serverInfo = parseServerInfoStatusPayload(envelope.message?.payload);
  expect(envelope.message?.type).toBe("status");
  expect(serverInfo).not.toBeNull();
  return serverInfo!;
}

function providerDiagnosticRequest() {
  return {
    type: "provider_diagnostic_request" as const,
    provider: "grok",
    requestId: "provider-diagnostic",
  };
}

function pluginRpcRequest(params: { pluginId: string; method: string }) {
  return {
    type: "plugin.rpc.invoke.request" as const,
    requestId: `${params.pluginId}-${params.method}`,
    pluginId: params.pluginId,
    method: params.method,
    input: null,
  };
}

// Requests are timed with performance.now(), which the fake timers drive.
async function sendSlowRequest(params: {
  socket: MockSocket;
  request: ReturnType<typeof pluginRpcRequest>;
  durationMs: number;
}): Promise<void> {
  const held = holdNextSessionMessage(sessionMock.instances[0]);
  params.socket.emit("message", JSON.stringify({ type: "session", message: params.request }));
  await vi.advanceTimersByTimeAsync(params.durationMs);
  held.finish();
  await vi.advanceTimersByTimeAsync(0);
}

function holdNextSessionMessage(session: (typeof sessionMock.instances)[number]): {
  finish: () => void;
} {
  let finish = () => {};
  session.handleMessage.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  return {
    finish: () => finish(),
  };
}

function holdSessionCleanup(session: (typeof sessionMock.instances)[number]): {
  finish: () => void;
} {
  let finish = () => {};
  session.cleanup.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  return {
    finish: () => finish(),
  };
}

describe("relay external socket reconnect behavior", () => {
  test("closes only a hello socket when post-admission setup throws", async () => {
    const server = createServer();
    class ThrowOnceSocket extends MockSocket {
      private firstClose = true;
      override close(code?: number, reason?: string): void {
        if (this.firstClose) {
          this.firstClose = false;
          throw new Error("socket close failed during hello");
        }
        super.close(code, reason);
      }
    }
    const failed = new ThrowOnceSocket();
    try {
      await server.attachExternalSocket(failed, { transport: "relay" });
      failed.emit("message", JSON.stringify(createHelloMessage("plugin:not-a-plugin")));
      await vi.waitFor(() => expect(failed.readyState).toBe(3));
      const initiallyFailed = new ThrowOnceSocket();
      await server.attachExternalSocket(
        initiallyFailed,
        { transport: "relay" },
        null,
        createHelloMessage("plugin:initially-invalid"),
      );
      await vi.waitFor(() => expect(initiallyFailed.readyState).toBe(3));
      const healthy = new MockSocket();
      await attachRelayAndHello({ server, socket: healthy, clientId: "still-running" });
    } finally {
      await server.close();
    }
  });

  test("does not log malformed pre-admission credential frames", async () => {
    const logger = createLogger();
    const server = createServer({ logger });
    const socket = new MockSocket();
    try {
      await server.attachExternalSocket(socket, { transport: "relay" });
      socket.emit("message", '{"type":"hello","auth":{"kind":"password","password":"log-secret"},');
      await vi.waitFor(() => expect(socket.readyState).toBe(3));
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain("log-secret");
    } finally {
      await server.close();
    }
  });
  test("admits a hello password and an old relay hello, but rejects a wrong password", async () => {
    const server = createServer({
      auth: {
        password: "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW",
        localCredential: () => "local-token",
      },
    });
    try {
      const passwordSocket = new MockSocket();
      await server.attachExternalSocket(passwordSocket, { transport: "relay" });
      passwordSocket.emit(
        "message",
        JSON.stringify({
          ...createHelloMessage("relay-password"),
          auth: { kind: "password", password: "correct-password" },
        }),
      );
      await vi.waitFor(() => expect(sentServerInfoEnvelopes(passwordSocket)).toHaveLength(1));

      const legacySocket = new MockSocket();
      await server.attachExternalSocket(legacySocket, { transport: "relay" });
      legacySocket.emit("message", JSON.stringify(createHelloMessage("relay-legacy")));
      await vi.waitFor(() => expect(sentServerInfoEnvelopes(legacySocket)).toHaveLength(1));

      const wrongSocket = new MockSocket();
      await server.attachExternalSocket(wrongSocket, { transport: "relay" });
      wrongSocket.emit(
        "message",
        JSON.stringify({
          ...createHelloMessage("relay-wrong"),
          auth: { kind: "password", password: "wrong" },
        }),
      );
      await vi.waitFor(() => expect(wrongSocket.readyState).toBe(3));
      expect(wrongSocket.sent).toContain(
        JSON.stringify({
          type: "hello.rejected",
          reason: "incorrect_password",
          accepts: ["password"],
        }),
      );
    } finally {
      await server.close();
    }
  });
  beforeEach(() => {
    sessionMock.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("keeps the same session when relay reconnects within grace window", async () => {
    const server = createServer();
    const clientId = "cid-relay-reconnect";

    const socket1 = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: socket1,
      clientId,
    });
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];

    socket1.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.cleanup).not.toHaveBeenCalled();

    const socket2 = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: socket2,
      clientId,
    });
    expect(sessionMock.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.cleanup).not.toHaveBeenCalled();

    await server.close();
  });

  test("gives every plugin socket an exclusively owned session and cleans it immediately", async () => {
    const server = createServer();
    const firstSocket = new MockSocket();
    const firstAttachment = await server.attachPluginSocket("exclusive", firstSocket);
    firstSocket.emit("message", JSON.stringify(createHelloMessage("plugin:exclusive")));

    const secondSocket = new MockSocket();
    const secondAttachment = await server.attachPluginSocket("exclusive", secondSocket);
    secondSocket.emit("message", JSON.stringify(createHelloMessage("plugin:exclusive")));

    await vi.waitFor(() => expect(sessionMock.instances).toHaveLength(2));
    firstSocket.emit("close", 1000, "plugin stopped");
    await firstAttachment.closed;
    expect(sessionMock.instances[0]?.cleanup).toHaveBeenCalledOnce();
    expect(sessionMock.instances[1]?.cleanup).not.toHaveBeenCalled();

    secondSocket.emit("close", 1000, "plugin stopped");
    await secondAttachment.closed;
    expect(sessionMock.instances[1]?.cleanup).toHaveBeenCalledOnce();
    await server.close();
  });

  test("keeps a plugin socket whose heartbeat stalls past the application lease", async () => {
    const server = createServer();
    const socket = new MockSocket();
    await server.attachPluginSocket("stalled", socket);
    socket.emit("message", JSON.stringify(createHelloMessage("plugin:stalled")));
    await vi.waitFor(() => expect(sentServerInfoEnvelopes(socket)).toHaveLength(1));
    socket.emit("message", JSON.stringify({ type: "ping" }));

    // Event loop starved past the lease: no further ping arrives.
    await vi.advanceTimersByTimeAsync(APPLICATION_SOCKET_LEASE_MS * 2);

    expect(socket.readyState).toBe(1);
    await server.close();
  });

  test("still reaps an ordinary socket whose heartbeat stalls past the application lease", async () => {
    const server = createServer();
    const socket = new MockSocket();
    await attachRelayAndHello({ server, socket, clientId: "cid-stalled" });
    socket.emit("message", JSON.stringify({ type: "ping" }));

    await vi.advanceTimersByTimeAsync(APPLICATION_SOCKET_LEASE_MS * 2);

    expect(socket.readyState).toBe(3);
    await server.close();
  });

  test("rejects ordinary sockets that claim the reserved plugin client id", async () => {
    const server = createServer();
    const socket = new MockSocket();
    await server.attachExternalSocket(socket, { transport: "relay" });
    socket.emit("message", JSON.stringify(createHelloMessage("plugin:not-a-plugin")));

    await vi.waitFor(() => expect(socket.readyState).toBe(3));
    expect(sessionMock.instances).toHaveLength(0);
    await server.close();
  });

  test("passes hello capabilities through to the created session", async () => {
    const server = createServer();
    const socket = new MockSocket();

    await asInternals<WebSocketServerInternals>(server).attachSocket(socket, createDirectRequest());
    socket.emit(
      "message",
      JSON.stringify(
        createHelloMessage("client-capabilities", {
          capabilities: { [CLIENT_CAPS.reasoningMergeEnum]: true },
        }),
      ),
    );
    await vi.waitFor(() => expect(sessionMock.instances).toHaveLength(1));
    const session = sessionMock.instances[0];
    expect(session.args.clientCapabilities).toEqual({
      [CLIENT_CAPS.reasoningMergeEnum]: true,
    });

    await server.close();
  });

  test("rejects sockets attached after shutdown begins", async () => {
    const server = createServer();
    const existingSocket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: existingSocket,
      clientId: "existing-client",
    });

    const heldCleanup = holdSessionCleanup(sessionMock.instances[0]);
    const closePromise = server.close();

    const lateSocket = new MockSocket();
    try {
      await server.attachExternalSocket(lateSocket, { transport: "relay" });
      lateSocket.emit("message", JSON.stringify(createHelloMessage("late-client")));

      expect({
        readyState: lateSocket.readyState,
        sessionCount: sessionMock.instances.length,
      }).toEqual({
        readyState: 3,
        sessionCount: 1,
      });
    } finally {
      heldCleanup.finish();
      await closePromise;
    }
  });

  test("accepts plugin startup sessions while application sessions remain paused", async () => {
    const server = createServer({ startPaused: true });
    const applicationSocket = new MockSocket();
    await server.attachExternalSocket(applicationSocket, { transport: "relay" });
    expect(applicationSocket.readyState).toBe(3);

    const pluginSocket = new MockSocket();
    const attachment = await server.attachPluginSocket("startup", pluginSocket);
    pluginSocket.emit("message", JSON.stringify(createHelloMessage("plugin:startup")));
    await vi.waitFor(() => expect(sessionMock.instances).toHaveLength(1));

    server.beginAcceptingConnections();
    const readySocket = new MockSocket();
    await attachRelayAndHello({ server, socket: readySocket, clientId: "ready-client" });
    expect(sessionMock.instances).toHaveLength(2);

    pluginSocket.emit("close", 1000, "done");
    await attachment.closed;
    await server.close();
  });

  test("closes pending connection when hello timeout elapses", async () => {
    const server = createServer();

    const socket = new MockSocket();
    let closeCode: number | null = null;
    let closeReason = "";
    socket.on("close", (code: unknown, reason: unknown) => {
      closeCode = typeof code === "number" ? code : null;
      closeReason = typeof reason === "string" ? reason : "";
    });

    await asInternals<WebSocketServerInternals>(server).attachSocket(socket, createDirectRequest());
    await vi.advanceTimersByTimeAsync(15_000);

    expect(closeCode).toBe(4001);
    expect(closeReason).toBe("Hello timeout");
    expect(sessionMock.instances).toHaveLength(0);

    await server.close();
  });

  test("returns server_info when clientId reconnects with existing session", async () => {
    const server = createServer();
    const clientId = "cid-resume-flag";

    const firstSocket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: firstSocket,
      clientId,
    });

    firstSocket.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(1_000);

    const secondSocket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: secondSocket,
      clientId,
    });

    await server.close();
  });

  test("returns server_info for distinct clientIds", async () => {
    const server = createServer();

    const firstSocket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: firstSocket,
      clientId: "cid-new-1",
    });

    const secondSocket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: secondSocket,
      clientId: "cid-new-2",
    });
    expect(sessionMock.instances).toHaveLength(2);

    await server.close();
  });

  test("isolates resumable sessions by principal while sharing hello bootstrap", async () => {
    const server = createServer();
    const clientId = "shared-client-id";
    const ownerSocket = new MockSocket();
    const hubSocket = new MockSocket();

    const ownerInfo = await attachRelayAndHello({ server, socket: ownerSocket, clientId });
    await server.attachExternalSocket(
      hubSocket,
      { transport: "hub", hubDaemonId: "daemon-1" },
      { principalId: "hub:daemon-1", permissions: ["hub.execute"] },
    );
    hubSocket.emit("message", JSON.stringify(createHelloMessage(clientId)));
    await vi.waitFor(() => expect(hubSocket.sent.length).toBeGreaterThan(0));
    const hubEnvelope = parseSentEnvelope(hubSocket.sent[0]);
    const hubInfo = parseServerInfoStatusPayload(hubEnvelope.message?.payload);

    expect(sessionMock.instances).toHaveLength(2);
    expect(ownerInfo.permissions).toEqual(DAEMON_PERMISSIONS);
    expect(hubInfo?.permissions).toEqual(["hub.execute"]);
    await server.close();
  });

  test("rejects session messages before hello", async () => {
    const server = createServer();
    const socket = new MockSocket();
    let closeCode: number | null = null;
    let closeReason = "";
    socket.on("close", (code: unknown, reason: unknown) => {
      closeCode = typeof code === "number" ? code : null;
      closeReason = typeof reason === "string" ? reason : "";
    });

    await server.attachExternalSocket(socket, { transport: "relay" });
    socket.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: {
          type: "ping",
        },
      }),
    );
    expect(closeCode).toBe(4002);
    expect(["Invalid hello", "Session message before hello"]).toContain(closeReason);
    expect(sessionMock.instances).toHaveLength(0);

    await server.close();
  });

  test("logs control RPCs with the socket identity", async () => {
    const { log, lines } = createCapturingLog();
    const server = createServer({ log });
    const socket = new MockSocket();

    await server.attachExternalSocket(socket, {
      transport: "relay",
      relayConnectionId: "relay-conn-1",
    });
    socket.emit("message", JSON.stringify(createHelloMessage("cid-control-log")));
    await vi.waitFor(() => expect(sentServerInfoEnvelopes(socket)).toHaveLength(1));
    socket.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: {
          type: "shutdown_server_request",
          requestId: "shutdown-1",
        },
      }),
    );
    await Promise.resolve();

    expect(linesWithMessage(lines, "ws_control_rpc_received")).toEqual([
      expect.objectContaining({
        level: 40,
        connectionId: expect.stringMatching(/^conn_/),
        transport: "relay",
        relayConnectionId: "relay-conn-1",
        clientId: "cid-control-log",
        sessionId: "mock-session-id",
        requestType: "shutdown_server_request",
        requestId: "shutdown-1",
        reason: "client_shutdown_rpc",
      }),
    ]);

    await server.close();
  });

  test("logs a slow plugin RPC with its plugin, method and the socket that sent it", async () => {
    const { log, lines, raw } = createCapturingLog();
    const server = createServer({ log });
    const clientId = "cid-slow-plugin-rpc";
    const relaySocket = new MockSocket();
    await attachRelayAndHello({ server, socket: relaySocket, clientId });
    const directSocket = new MockSocket();
    await attachDirectAndHello({ server, socket: directSocket, clientId });

    await sendSlowRequest({
      socket: directSocket,
      request: pluginRpcRequest({ pluginId: "aster", method: "usage.snapshot" }),
      durationMs: 1_350,
    });

    expect(linesWithMessage(lines, "ws_slow_request")).toEqual([
      expect.objectContaining({
        level: 40,
        requestType: "plugin.rpc.invoke.request",
        pluginId: "aster",
        method: "usage.snapshot",
        durationMs: 1_350,
        transport: "direct",
        peer: "loopback",
        clientId,
        sessionId: "mock-session-id",
      }),
    ]);
    const slowRequestLine = raw.find((line) => line.includes('"ws_slow_request"')) ?? "";
    expect(slowRequestLine.match(/"(connectionId|transport|clientId)":/g)).toEqual([
      '"connectionId":',
      '"transport":',
      '"clientId":',
    ]);

    await server.close();
  });

  test("folds repeats of a slow request kind into one summary per minute", async () => {
    const { log, lines } = createCapturingLog();
    const server = createServer({ log });
    const clientId = "cid-slow-repeat";
    const socket = new MockSocket();
    await attachRelayAndHello({ server, socket, clientId });
    const usagePoll = pluginRpcRequest({ pluginId: "aster", method: "usage.snapshot" });

    for (const durationMs of [1_300, 2_700, 6_700]) {
      await sendSlowRequest({ socket, request: usagePoll, durationMs });
    }
    await sendSlowRequest({
      socket,
      request: pluginRpcRequest({ pluginId: "settings-sync", method: "relay.pull" }),
      durationMs: 900,
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(linesWithMessage(lines, "ws_slow_request")).toEqual([
      expect.objectContaining({ pluginId: "aster", method: "usage.snapshot", durationMs: 1_300 }),
      expect.objectContaining({ pluginId: "settings-sync", method: "relay.pull", durationMs: 900 }),
    ]);
    expect(linesWithMessage(lines, "ws_slow_request_summary")).toEqual([
      expect.objectContaining({
        level: 30,
        requestType: "plugin.rpc.invoke.request",
        pluginId: "aster",
        method: "usage.snapshot",
        clientId,
        count: 3,
        p50Ms: 2_700,
        maxMs: 6_700,
        windowMs: 60_000,
      }),
    ]);

    await sendSlowRequest({ socket, request: usagePoll, durationMs: 1_400 });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(linesWithMessage(lines, "ws_slow_request")).toHaveLength(2);
    expect(linesWithMessage(lines, "ws_slow_request_summary")).toEqual([
      expect.objectContaining({ method: "usage.snapshot", count: 3 }),
      expect.objectContaining({ method: "usage.snapshot", count: 1, p50Ms: 1_400, maxMs: 1_400 }),
    ]);

    await server.close();
  });

  test("announces a socket that joins a live session with its first request", async () => {
    const { log, lines } = createCapturingLog();
    const server = createServer({ log });
    const clientId = "cid-joining-socket";
    const firstSocket = new MockSocket();
    await attachDirectAndHello({ server, socket: firstSocket, clientId });
    const joiningSocket = new MockSocket();
    await attachRelayAndHello({ server, socket: joiningSocket, clientId });

    expect(linesWithMessage(lines, "Client connected via hello")).toEqual([
      expect.objectContaining({ level: 30, transport: "direct", resumed: false }),
    ]);

    joiningSocket.emit(
      "message",
      JSON.stringify({ type: "session", message: providerDiagnosticRequest() }),
    );
    await Promise.resolve();

    expect(linesWithMessage(lines, "Client connected via hello")).toEqual([
      expect.objectContaining({ transport: "direct", resumed: false }),
      expect.objectContaining({ level: 30, transport: "relay", resumed: true, clientId }),
    ]);

    await server.close();
  });

  test("reports sockets that close without a request once, then as a summary", async () => {
    const { log, lines } = createCapturingLog();
    const server = createServer({ log });
    const clientId = "cid-connection-probe";
    const liveSocket = new MockSocket();
    await attachDirectAndHello({ server, socket: liveSocket, clientId });

    for (const lifetimeMs of [330, 340, 350]) {
      const probe = new MockSocket();
      await server.attachExternalSocket(probe, { transport: "relay" });
      probe.emit("message", JSON.stringify(createHelloMessage(clientId)));
      await vi.advanceTimersByTimeAsync(lifetimeMs);
      probe.emit("close", 1001, "Client disconnected");
    }
    await vi.advanceTimersByTimeAsync(60_000);

    const disconnects = linesWithMessage(
      lines,
      "Client socket disconnected; session remains attached",
    );
    expect(disconnects).toEqual([
      expect.objectContaining({
        level: 30,
        transport: "relay",
        peer: "external",
        clientId,
        code: 1001,
        lifetimeMs: 330,
        sessionRequests: 0,
        remainingSockets: 1,
      }),
      expect.objectContaining({ level: 20, lifetimeMs: 340 }),
      expect.objectContaining({ level: 20, lifetimeMs: 350 }),
    ]);
    expect(linesWithMessage(lines, "Client connected via hello")).toHaveLength(1);
    expect(linesWithMessage(lines, "ws_unused_socket_summary")).toEqual([
      expect.objectContaining({
        level: 30,
        clientId,
        transport: "relay",
        peer: "external",
        count: 3,
        p50LifetimeMs: 340,
        maxLifetimeMs: 350,
        windowMs: 60_000,
      }),
    ]);

    await server.close();
  });

  test("keeps the disconnect line of a socket that carried requests", async () => {
    const { log, lines } = createCapturingLog();
    const server = createServer({ log });
    const clientId = "cid-used-socket";
    const liveSocket = new MockSocket();
    await attachDirectAndHello({ server, socket: liveSocket, clientId });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const socket = new MockSocket();
      await server.attachExternalSocket(socket, { transport: "relay" });
      socket.emit("message", JSON.stringify(createHelloMessage(clientId)));
      await vi.advanceTimersByTimeAsync(100);
      socket.emit(
        "message",
        JSON.stringify({ type: "session", message: providerDiagnosticRequest() }),
      );
      await vi.advanceTimersByTimeAsync(200);
      socket.emit("close", 1001, "Client disconnected");
    }

    expect(linesWithMessage(lines, "Client socket disconnected; session remains attached")).toEqual(
      [
        expect.objectContaining({ level: 30, sessionRequests: 1, lifetimeMs: 300 }),
        expect.objectContaining({ level: 30, sessionRequests: 1, lifetimeMs: 300 }),
      ],
    );

    await server.close();
  });

  test("gives a session logger no socket identity", async () => {
    const { log } = createCapturingLog();
    const server = createServer({ log });
    const socket = new MockSocket();
    await attachRelayAndHello({ server, socket, clientId: "cid-session-logger" });

    const sessionLogger = sessionMock.instances[0].args.logger as pino.Logger;
    expect(sessionLogger.bindings()).toEqual({ module: "websocket-server" });

    await server.close();
  });

  test("merges runtime metrics windows while nothing is streaming", async () => {
    const { log, lines } = createCapturingLog();
    const server = createServer({ log });
    const socket = new MockSocket();
    await attachRelayAndHello({ server, socket, clientId: "cid-runtime-metrics" });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(linesWithMessage(lines, "ws_runtime_metrics")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(9 * 30_000);
    expect(linesWithMessage(lines, "ws_runtime_metrics")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(linesWithMessage(lines, "ws_runtime_metrics")).toEqual([
      expect.objectContaining({ windowMs: 30_000 }),
      expect.objectContaining({ windowMs: 300_000 }),
    ]);

    await server.close();
  });

  test("keeps 30 second runtime metrics windows while agent output streams", async () => {
    const { log, lines } = createCapturingLog();
    const server = createServer({ log });
    const socket = new MockSocket();
    await attachRelayAndHello({ server, socket, clientId: "cid-runtime-metrics-stream" });
    await vi.advanceTimersByTimeAsync(30_000);

    sessionMock.instances[0].publish({
      type: "agent_stream",
      payload: {
        agentId: "agent-1",
        event: { type: "turn_completed", provider: "codex" },
        timestamp: "2026-11-10T00:00:00.000Z",
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(linesWithMessage(lines, "ws_runtime_metrics")).toEqual([
      expect.objectContaining({ windowMs: 30_000 }),
      expect.objectContaining({
        windowMs: 30_000,
        outboundAgentStreamTypesTop: [["turn_completed", 1]],
      }),
    ]);

    await server.close();
  });

  test("logs each window's measurements every 30 seconds and standing state every 5 minutes", async () => {
    const { log, lines } = createCapturingLog();
    const server = createServer({ log });
    const socket = new MockSocket();
    await attachRelayAndHello({ server, socket, clientId: "cid-runtime-metrics-gauges" });
    const streamOneWindow = async () => {
      sessionMock.instances[0].publish({
        type: "agent_stream",
        payload: {
          agentId: "agent-1",
          event: { type: "turn_completed", provider: "codex" },
          timestamp: "2026-11-10T00:00:00.000Z",
        },
      });
      await vi.advanceTimersByTimeAsync(30_000);
    };

    for (let window = 0; window < 11; window += 1) await streamOneWindow();

    const logged = linesWithMessage(lines, "ws_runtime_metrics");
    expect(logged).toHaveLength(11);
    expect(logged.map((line) => line.elided)).toEqual([
      "zeros",
      ...Array.from({ length: 9 }, () => "zeros+gauges"),
      "zeros",
    ]);
    expect(logged[0]).toHaveProperty("runtime");
    expect(logged[0]).toHaveProperty("sessions.activeConnections", 1);
    expect(logged[10]).toHaveProperty("sessions.activeConnections", 1);
    for (const line of logged.slice(1, 10)) {
      expect(line).toMatchObject({
        windowMs: 30_000,
        outboundAgentStreamTypesTop: [["turn_completed", 1]],
        git: { commands: expect.any(Object) },
      });
      expect(line).toHaveProperty("eventLoopDelay");
      expect(line).not.toHaveProperty("runtime");
      expect(line).not.toHaveProperty("sessions");
      expect(line).not.toHaveProperty("counters");
    }
    // Diagnostics still read the full window.
    const getMetrics = sessionMock.instances[0].args.getWebSocketRuntimeMetrics as () => {
      counters: Record<string, number>;
      git: { workspaceService: unknown };
    };
    expect(getMetrics().counters).toMatchObject({ validationFailed: 0, helloNew: 0 });
    expect(getMetrics().git.workspaceService).toEqual(expect.any(Object));

    await server.close();
  });

  test("responds to top-level ping while provider diagnostic is still running", async () => {
    const server = createServer();
    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-ping-during-provider-diagnostic",
    });

    const session = sessionMock.instances[0];
    const providerDiagnostic = holdNextSessionMessage(session);

    const sentBeforeDiagnostic = socket.sent.length;
    socket.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: {
          type: "provider_diagnostic_request",
          provider: "grok",
          requestId: "slow-provider-diagnostic",
        },
      }),
    );
    await vi.waitFor(() => {
      expect(session.handleMessage).toHaveBeenCalledTimes(1);
    });

    socket.emit("message", JSON.stringify({ type: "ping" }));
    await Promise.resolve();

    expect(sentEnvelopes(socket).slice(sentBeforeDiagnostic)).toContainEqual({ type: "pong" });

    providerDiagnostic.finish();
    await Promise.resolve();
    await server.close();
  });

  test("routes later session requests while provider diagnostic is still running", async () => {
    const server = createServer();
    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-session-request-during-provider-diagnostic",
    });

    const session = sessionMock.instances[0];
    const providerDiagnostic = holdNextSessionMessage(session);

    socket.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: {
          type: "provider_diagnostic_request",
          provider: "grok",
          requestId: "slow-provider-diagnostic",
        },
      }),
    );
    await vi.waitFor(() => {
      expect(session.handleMessage).toHaveBeenCalledTimes(1);
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: {
          type: "ping",
          requestId: "second-session-request",
          clientSentAt: Date.now(),
        },
      }),
    );
    await vi.waitFor(() => {
      expect(session.handleMessage).toHaveBeenCalledTimes(2);
    });

    providerDiagnostic.finish();
    await Promise.resolve();
    await server.close();
  });

  test("sends rpc_error when an async session request fails", async () => {
    const server = createServer();
    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-session-request-failure",
    });

    const session = sessionMock.instances[0];
    session.handleMessage.mockRejectedValueOnce(new Error("handler exploded"));

    const sentBeforeRequest = socket.sent.length;
    socket.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: {
          type: "provider_diagnostic_request",
          provider: "grok",
          requestId: "failing-provider-diagnostic",
        },
      }),
    );

    await vi.waitFor(() => {
      expect(sentEnvelopes(socket).slice(sentBeforeRequest)).toContainEqual({
        type: "session",
        message: {
          type: "rpc_error",
          payload: {
            requestId: "failing-provider-diagnostic",
            requestType: "provider_diagnostic_request",
            error: "Invalid message: handler exploded",
            code: "invalid_message",
          },
        },
      });
    });

    await server.close();
  });

  test("reuses direct session when same clientId reconnects within grace window", async () => {
    const server = createServer();
    const clientId = "cid-direct-reconnect";

    const socket1 = new MockSocket();
    await attachDirectAndHello({
      server,
      socket: socket1,
      clientId,
    });
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];

    socket1.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.cleanup).not.toHaveBeenCalled();

    const socket2 = new MockSocket();
    await attachDirectAndHello({
      server,
      socket: socket2,
      clientId,
    });
    expect(sessionMock.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.cleanup).not.toHaveBeenCalled();

    await server.close();
  });

  test("reuses one session when switching from direct to relay with the same clientId", async () => {
    const server = createServer();
    const clientId = "cid-switch-path";

    const directSocket = new MockSocket();
    await attachDirectAndHello({
      server,
      socket: directSocket,
      clientId,
    });
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];

    const relaySocket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: relaySocket,
      clientId,
    });
    expect(sessionMock.instances).toHaveLength(1);

    const { onMessage } = session.args;
    expect(onMessage).toBeTypeOf("function");
    if (typeof onMessage === "function") {
      onMessage({
        type: "status",
        payload: { status: "ok" },
      });
    }

    expect(directSocket.sent.length).toBeGreaterThan(0);
    expect(relaySocket.sent.length).toBeGreaterThan(0);

    directSocket.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.cleanup).not.toHaveBeenCalled();

    relaySocket.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(session.cleanup).toHaveBeenCalledTimes(1);

    await server.close();
  });

  test("cleans up relay session when reconnect grace expires", async () => {
    const server = createServer();
    const clientId = "cid-relay-grace-expire";

    const socket1 = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: socket1,
      clientId,
    });
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];

    socket1.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(session.cleanup).toHaveBeenCalledTimes(1);

    await server.close();
  });

  test("advertises current features in initial server_info", async () => {
    const server = createServer();
    const socket = new MockSocket();

    const serverInfo = await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-stable-project-identity",
    });

    expect(serverInfo.features?.stableProjectIdentity).toBe(true);
    expect(serverInfo.features?.canonicalSubmittedPrompts).toBe(true);
    expect(serverInfo.features?.providersSnapshotCwd).toBe(true);
    expect(serverInfo.features?.hopliteProvider).toBe(false);
    expect(serverInfo.features?.pluginLogs).toBe(true);
    expect(serverInfo.features?.workspaceMarkUnread).toBe(true);
    expect(serverInfo.features?.["terminal-input-mode-replay"]).toBe(true);
    expect(serverInfo.features?.["terminal-size-ownership"]).toBe(true);
    expect(serverInfo.features?.agentTurnIdentity).toBeUndefined();
    expect(serverInfo.permissions).toEqual(DAEMON_PERMISSIONS);
    await server.close();
  });

  test("includes voice capabilities in initial server_info when speech readiness exists", async () => {
    const speechReadiness = createReadySpeechReadinessSnapshot();
    const server = createServer({ speechReadiness });

    const socket = new MockSocket();
    const serverInfo = (await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-server-info-capabilities",
    })) as {
      version?: unknown;
      capabilities?: {
        voice?: {
          dictation?: { enabled?: unknown; reason?: unknown };
          voice?: { enabled?: unknown; reason?: unknown };
        };
      };
    };
    expect(serverInfo.version).toBe(TEST_DAEMON_VERSION);
    expect(serverInfo.capabilities?.voice?.dictation?.enabled).toBe(
      speechReadiness.dictation.enabled,
    );
    expect(serverInfo.capabilities?.voice?.dictation?.reason).toBe("");
    expect(serverInfo.capabilities?.voice?.voice?.enabled).toBe(
      speechReadiness.realtimeVoice.enabled,
    );
    expect(serverInfo.capabilities?.voice?.voice?.reason).toBe("");

    await server.close();
  });

  test("broadcasts updated server_info when capabilities change", async () => {
    const server = createServer();

    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-server-info-broadcast",
    });
    expect(sentServerInfoEnvelopes(socket)).toHaveLength(1);

    const speechReadiness = createReadySpeechReadinessSnapshot();
    server.publishSpeechReadiness(speechReadiness);
    expect(sentServerInfoEnvelopes(socket)).toHaveLength(2);

    const secondEnvelope = sentServerInfoEnvelopes(socket)[1];
    const secondPayload = parseServerInfoStatusPayload(secondEnvelope.message?.payload);
    expect(secondPayload?.capabilities?.voice?.dictation.enabled).toBe(true);
    expect(secondPayload?.capabilities?.voice?.voice.enabled).toBe(true);

    // Same readiness should not produce another server_info broadcast.
    server.publishSpeechReadiness(speechReadiness);
    expect(sentServerInfoEnvelopes(socket)).toHaveLength(2);

    await server.close();
  });

  test("includes temporary retry guidance while models are downloading", async () => {
    const server = createServer();
    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-server-info-download-guidance",
    });
    expect(sentServerInfoEnvelopes(socket)).toHaveLength(1);

    server.publishSpeechReadiness(createDownloadInProgressSpeechReadinessSnapshot());
    expect(sentServerInfoEnvelopes(socket)).toHaveLength(2);

    const envelope = sentServerInfoEnvelopes(socket)[1];
    const payload = parseServerInfoStatusPayload(envelope.message?.payload);
    expect(payload?.capabilities?.voice?.dictation.enabled).toBe(true);
    expect(payload?.capabilities?.voice?.voice.enabled).toBe(true);
    expect(payload?.capabilities?.voice?.dictation.reason).toContain("Try again in a few minutes.");
    expect(payload?.capabilities?.voice?.voice.reason).toContain("Try again in a few minutes.");

    await server.close();
  });

  test("routes inbound terminal frames to session.handleBinaryFrame", async () => {
    const server = createServer();

    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-binary-inbound",
    });
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];

    socket.emit(
      "message",
      Buffer.from(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          slot: 9,
          payload: new TextEncoder().encode("ls\r"),
        }),
      ),
    );
    expect(session.handleBinaryFrame).toHaveBeenCalledTimes(1);
    const { frame } = BinaryFrameSchema.parse(session.handleBinaryFrame.mock.calls[0]?.[0]);
    expect(frame.opcode).toBe(TerminalStreamOpcode.Input);
    expect(frame.slot).toBe(9);
    expect(new TextDecoder().decode(frame.payload)).toBe("ls\r");

    await server.close();
  });

  test("sends status error when async binary frame handling fails", async () => {
    const server = createServer();

    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-binary-inbound-failure",
    });
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];
    session.handleBinaryFrame.mockRejectedValueOnce(new Error("binary exploded"));

    const sentBeforeFrame = socket.sent.length;
    socket.emit(
      "message",
      Buffer.from(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          slot: 11,
          payload: new TextEncoder().encode("pwd\r"),
        }),
      ),
    );

    await vi.waitFor(() => {
      expect(sentEnvelopes(socket).slice(sentBeforeFrame)).toContainEqual({
        type: "session",
        message: {
          type: "status",
          payload: {
            status: "error",
            message: "Invalid message: binary exploded",
          },
        },
      });
    });

    await server.close();
  });

  test("sends outbound terminal frames from session over websocket", async () => {
    const server = createServer();

    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-binary-outbound",
    });
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];

    const { onBinaryMessage } = session.args;
    expect(onBinaryMessage).toBeTypeOf("function");
    if (typeof onBinaryMessage === "function") {
      onBinaryMessage(new Uint8Array([TerminalStreamOpcode.Output, 12, 0x6f, 0x6b]));
    }

    const terminalFrames = sentTerminalFrames(socket);
    expect(terminalFrames).toHaveLength(1);
    const frame = terminalFrames[0];
    expect(frame.opcode).toBe(TerminalStreamOpcode.Output);
    expect(frame.slot).toBe(12);
    expect(new TextDecoder().decode(frame.payload ?? new Uint8Array())).toBe("ok");

    await server.close();
  });
});
