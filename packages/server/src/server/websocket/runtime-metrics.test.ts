import { describe, expect, it } from "vitest";
import type { SessionOutboundMessage, WSOutboundMessage } from "../messages.js";
import { wrapSessionMessage } from "../messages.js";
import {
  compactRuntimeMetricsForLog,
  isNotableRuntimeMetricsWindow,
  WebSocketRuntimeMetricsWindow,
} from "./runtime-metrics.js";

function createMetricsWindow(): {
  metrics: WebSocketRuntimeMetricsWindow;
  advanceClock(ms: number): void;
} {
  let now = 1_000;
  return {
    metrics: new WebSocketRuntimeMetricsWindow(() => now),
    advanceClock(ms: number) {
      now += ms;
    },
  };
}

function agentStreamMessage(params: {
  agentId: string;
  event: Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"]["event"];
}): WSOutboundMessage {
  return wrapSessionMessage({
    type: "agent_stream",
    payload: {
      agentId: params.agentId,
      event: params.event,
      timestamp: "2026-04-17T00:00:00.000Z",
    },
  });
}

describe("WebSocketRuntimeMetricsWindow", () => {
  it("records outbound message type counts in the runtime metrics window", () => {
    const { metrics } = createMetricsWindow();

    metrics.recordOutboundMessage(
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "turn_completed",
          provider: "codex",
        },
      }),
      0,
    );
    metrics.recordOutboundMessage(
      wrapSessionMessage({
        type: "status",
        payload: {
          status: "ok",
          message: "ready",
        },
      }),
      0,
    );
    metrics.recordOutboundMessage({ type: "pong" }, 0);

    const snapshot = metrics.snapshotAndReset();

    expect(snapshot.outboundMessageTypesTop).toEqual([
      ["session_message", 2],
      ["pong", 1],
    ]);
    expect(snapshot.outboundSessionMessageTypesTop).toEqual([
      ["agent_stream", 1],
      ["status", 1],
    ]);
  });

  it("records agent_stream subtypes and top agents", () => {
    const { metrics } = createMetricsWindow();

    metrics.recordOutboundMessage(
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "hello" },
        },
      }),
      0,
    );
    metrics.recordOutboundMessage(
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "reasoning", text: "thinking" },
        },
      }),
      0,
    );
    metrics.recordOutboundMessage(
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "turn_completed",
          provider: "codex",
        },
      }),
      0,
    );
    metrics.recordOutboundMessage(
      agentStreamMessage({
        agentId: "agent-2",
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "there" },
        },
      }),
      0,
    );

    const snapshot = metrics.snapshotAndReset();

    expect(snapshot.outboundAgentStreamTypesTop).toEqual([
      ["timeline:assistant_message", 2],
      ["timeline:reasoning", 1],
      ["turn_completed", 1],
    ]);
    expect(snapshot.outboundAgentStreamAgentsTop).toEqual([
      ["agent-1", 3],
      ["agent-2", 1],
    ]);
  });

  it("records bufferedAmount p95 and max from samples taken after send", () => {
    const { metrics } = createMetricsWindow();

    metrics.recordOutboundMessage(
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "turn_completed",
          provider: "codex",
        },
      }),
      0,
    );
    metrics.recordOutboundMessage(
      wrapSessionMessage({
        type: "status",
        payload: { status: "ok" },
      }),
      10,
    );
    metrics.recordOutboundMessage({ type: "pong" }, 50);
    metrics.recordOutboundBinaryFrame(100);

    const snapshot = metrics.snapshotAndReset();

    expect(snapshot.bufferedAmount).toEqual({
      p95: 100,
      max: 100,
    });
  });

  it("counts binary frames without decoding", () => {
    const { metrics } = createMetricsWindow();

    metrics.recordOutboundBinaryFrame(24);

    const snapshot = metrics.snapshotAndReset();
    expect(snapshot.outboundBinaryFrameTypesTop).toEqual([["binary", 1]]);
  });

  it("reports stream activity only while agent output or binary frames went out", () => {
    const { metrics } = createMetricsWindow();
    metrics.recordInboundSessionRequest("usage.list_reports.request");
    metrics.recordOutboundMessage({ type: "pong" }, 0);
    expect(metrics.hasStreamActivity()).toBe(false);

    metrics.recordOutboundMessage(
      agentStreamMessage({
        agentId: "agent-1",
        event: { type: "turn_completed", provider: "codex" },
      }),
      0,
    );
    expect(metrics.hasStreamActivity()).toBe(true);

    metrics.snapshotAndReset();
    expect(metrics.hasStreamActivity()).toBe(false);

    metrics.recordOutboundBinaryFrame(24);
    expect(metrics.hasStreamActivity()).toBe(true);
  });

  it("resets the runtime window after producing a snapshot", () => {
    const { metrics, advanceClock } = createMetricsWindow();
    metrics.incrementCounter("helloNew");
    metrics.recordInboundMessage("session");
    metrics.recordInboundSessionRequest("send");
    metrics.recordRequestLatency("send", 12.4);
    advanceClock(250);

    const firstSnapshot = metrics.snapshotAndReset();
    const secondSnapshot = metrics.snapshotAndReset();

    expect(firstSnapshot.windowMs).toBe(250);
    expect(firstSnapshot.counters.helloNew).toBe(1);
    expect(firstSnapshot.inboundMessageTypesTop).toEqual([["session", 1]]);
    expect(firstSnapshot.inboundSessionRequestTypesTop).toEqual([["send", 1]]);
    expect(firstSnapshot.latency).toEqual([
      {
        type: "send",
        count: 1,
        minMs: 12,
        maxMs: 12,
        p50Ms: 12,
        totalMs: 12,
      },
    ]);
    expect(secondSnapshot.windowMs).toBe(0);
    expect(secondSnapshot.counters.helloNew).toBe(0);
    expect(secondSnapshot.inboundMessageTypesTop).toEqual([]);
    expect(secondSnapshot.inboundSessionRequestTypesTop).toEqual([]);
    expect(secondSnapshot.latency).toEqual([]);
  });
});

function logPayload() {
  const { metrics, advanceClock } = createMetricsWindow();
  metrics.recordInboundMessage("session");
  metrics.recordRequestLatency("fetch_agent_timeline_request", 120);
  advanceClock(30_000);
  const window = metrics.snapshotAndReset();
  return {
    ...window,
    final: false,
    sessions: { activeConnections: 2, externalSessionKeys: 1, reconnectGraceSessions: 0 },
    sockets: { activeSockets: 2, pendingConnections: 0 },
    eventLoopDelay: { p50Ms: 20.1, p99Ms: 31.4, maxMs: 40.2 },
    uptimeSeconds: 120.5,
    memory: { rss: 1, heapTotal: 1, heapUsed: 1, external: 1, arrayBuffers: 1 },
    runtime: { inflightRequests: 0, peakInflightRequests: 1 },
    agents: { total: 3 },
    git: {
      commands: {
        submitted: 4,
        failed: 0,
        operationsTop: [["status", 4]],
        pendingProvenanceTop: [],
      },
      workspaceService: {
        workspaceTargetCount: 6,
        fetchInFlightCount: 0,
        fileObserver: { nativeEventCount: 12, lastReconciliationDurationMs: 0.21970400214195251 },
      },
    },
  };
}

describe("runtime metrics log lines", () => {
  it("leaves out zero counts, empty lists, and a false final flag", () => {
    const logged = compactRuntimeMetricsForLog(logPayload(), { includeGauges: true });

    expect(logged).not.toHaveProperty("final");
    expect(logged).not.toHaveProperty("counters");
    expect(logged).not.toHaveProperty("outboundAgentStreamTypesTop");
    expect(logged).toMatchObject({
      windowMs: 30_000,
      inboundMessageTypesTop: [["session", 1]],
      latency: [expect.objectContaining({ type: "fetch_agent_timeline_request", maxMs: 120 })],
      sessions: { activeConnections: 2, externalSessionKeys: 1 },
      runtime: { peakInflightRequests: 1 },
      git: {
        commands: { submitted: 4, operationsTop: [["status", 4]] },
        workspaceService: {
          workspaceTargetCount: 6,
          fileObserver: { nativeEventCount: 12, lastReconciliationDurationMs: 0.2 },
        },
      },
      elided: "zeros",
    });
    expect((logged.git as { commands: object }).commands).not.toHaveProperty("failed");
    expect(logged.sessions).not.toHaveProperty("reconnectGraceSessions");
    expect(JSON.stringify(logged).length).toBeLessThan(JSON.stringify(logPayload()).length);
  });

  it("keeps the window's own measurements and leaves standing state out between gauge lines", () => {
    const logged = compactRuntimeMetricsForLog(logPayload(), { includeGauges: false });

    for (const gauge of ["sessions", "sockets", "memory", "runtime", "agents"]) {
      expect(logged).not.toHaveProperty(gauge);
    }
    expect(logged.git).toEqual({ commands: { submitted: 4, operationsTop: [["status", 4]] } });
    expect(logged).toMatchObject({
      eventLoopDelay: { maxMs: 40.2 },
      uptimeSeconds: 120.5,
      elided: "zeros+gauges",
    });
  });

  it("calls a window notable for a stall, a slow request, a Git burst, or a rejected socket", () => {
    const calm = logPayload();
    expect(isNotableRuntimeMetricsWindow(calm)).toBe(false);
    expect(
      isNotableRuntimeMetricsWindow({ ...calm, counters: { ...calm.counters, helloNew: 3 } }),
    ).toBe(false);

    expect(isNotableRuntimeMetricsWindow({ ...calm, final: true })).toBe(true);
    expect(
      isNotableRuntimeMetricsWindow({
        ...calm,
        eventLoopDelay: { p50Ms: 20, p99Ms: 90, maxMs: 214 },
      }),
    ).toBe(true);
    expect(
      isNotableRuntimeMetricsWindow({ ...calm, latency: [{ ...calm.latency[0]!, maxMs: 4_500 }] }),
    ).toBe(true);
    expect(
      isNotableRuntimeMetricsWindow({
        ...calm,
        git: { ...calm.git, commands: { ...calm.git.commands, submitted: 21 } },
      }),
    ).toBe(true);
    expect(
      isNotableRuntimeMetricsWindow({ ...calm, counters: { ...calm.counters, originRejected: 1 } }),
    ).toBe(true);
  });
});
