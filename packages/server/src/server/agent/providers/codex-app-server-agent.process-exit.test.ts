import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino, { type Logger } from "pino";
import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager, type AgentManagerEvent } from "../agent-manager.js";
import { toAgentPayload } from "../agent-projections.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent-sdk-types.js";
import { CodexAppServerAgentClient, CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "./codex/test-utils/fake-app-server.js";

const logger = createTestLogger();

interface PendingPlanLifecycle {
  close(): Promise<void>;
  crashDuringActiveTurn(): Promise<void>;
  expectCanceledPlan(): void;
}

async function withPendingPlan(
  runScenario: (plan: PendingPlanLifecycle) => Promise<void>,
): Promise<void> {
  const workdir = mkdtempSync(join(tmpdir(), "codex-plan-cancel-"));
  const appServer = createFakeCodexAppServer();
  const client = new ProcessExitCodexClient([appServer]);
  const session = await client.createSession({
    provider: "codex",
    cwd: workdir,
    modeId: "auto",
    model: "gpt-5.4",
    featureValues: { plan_mode: true },
  });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    const run = session.run("make a plan");
    await appServer.waitForTurnStart();
    appServer.startsTurn({ threadId: "thread-1", turnId: "plan-turn" });
    appServer.updatesPlan({ threadId: "thread-1", steps: ["Inspect README"] });
    appServer.completeTurn();
    await run;
    const proposal = events.find(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.name === "plan_approval",
    );
    expect(proposal).toBeDefined();
    const [request] = session.getPendingPermissions?.() ?? [];
    expect(request).toBeDefined();
    await runScenario({
      close: () => session.close(),
      async crashDuringActiveTurn() {
        appServer.startsTurn({ threadId: "thread-1", turnId: "autonomous-turn" });
        await expect
          .poll(() => events.filter((event) => event.type === "turn_started").length)
          .toBe(2);
        appServer.child.emit("exit", 17, null);
        await expect.poll(() => events.some((event) => event.type === "turn_failed")).toBe(true);
      },
      expectCanceledPlan() {
        expect(session.getPendingPermissions?.()).toEqual([]);
        expect(events).toContainEqual({
          ...proposal,
          item: expect.objectContaining({
            type: "tool_call",
            name: "plan_approval",
            callId: request?.id,
            status: "canceled",
            detail: { type: "plan", text: "- Inspect README" },
          }),
        });
      },
    });
  } finally {
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
}

test("closing a session retains a canceled pending plan", async () => {
  await withPendingPlan(async (plan) => {
    await plan.close();
    plan.expectCanceledPlan();
  });
});

test("an active provider crash retains a canceled pending plan", async () => {
  await withPendingPlan(async (plan) => {
    await plan.crashDuringActiveTurn();
    plan.expectCanceledPlan();
  });
});

class ProcessExitCodexClient extends CodexAppServerAgentClient implements AgentClient {
  constructor(private readonly appServers: FakeCodexAppServer[]) {
    super(logger);
  }

  override async isAvailable(): Promise<boolean> {
    return true;
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = new CodexAppServerAgentSession(
      config,
      null,
      logger,
      async () => {
        const appServer = this.appServers.shift();
        if (!appServer) {
          throw new Error("No fake Codex app-server available");
        }
        return appServer.child;
      },
      {},
      false,
      false,
      false,
      launchContext?.agentId,
    );
    await session.connect();
    return session;
  }
}

test("unexpected Codex app-server exit fails the active run and agent", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-exit-"));
  const appServer = createFakeCodexAppServer();
  const manager = new AgentManager({
    clients: { codex: new ProcessExitCodexClient([appServer]) },
    logger,
  });
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
  let agentId: string | null = null;

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;
    const run = manager.runAgent(agent.id, "keep working");
    const turnStart = await appServer.waitForTurnStart();
    appServer.startsTurn({ threadId: String(turnStart.threadId), turnId: "native-turn-1" });
    await manager.waitForAgentRunStart(agent.id);

    appServer.child.stderr.write("provider crashed");
    appServer.child.emit("exit", 17, null);
    appServer.child.emit("exit", 17, null);

    await expect(run).rejects.toThrow(
      "Codex app-server exited with code 17 and signal null\nprovider crashed",
    );
    await expect.poll(() => manager.getAgent(agent.id)?.lifecycle).toBe("error");
    expect(manager.getAgent(agent.id)?.lastError).toBe(
      "Codex app-server exited with code 17 and signal null\nprovider crashed",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent_stream",
        agentId: agent.id,
        event: expect.objectContaining({
          type: "turn_failed",
          error: "Codex app-server exited with code 17 and signal null\nprovider crashed",
        }),
      }),
    );
    expect(
      events.filter((event) => event.type === "agent_stream" && event.event.type === "turn_failed"),
    ).toHaveLength(1);
  } finally {
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    unsubscribe();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("replacement self-heals when Codex reports that the tracked turn is already idle", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-already-idle-replace-"));
  const appServer = createFakeCodexAppServer({
    "turn/interrupt": () => ({
      __jsonRpcError: { code: -32600, message: "no active turn to interrupt" },
    }),
  });
  const manager = new AgentManager({
    clients: { codex: new ProcessExitCodexClient([appServer]) },
    logger,
  });
  let agentId: string | null = null;

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;
    const firstRun = manager.runAgent(agent.id, "keep working");
    const firstTurnStart = await appServer.waitForTurnStart();
    appServer.startsTurn({
      threadId: String(firstTurnStart.threadId),
      turnId: "native-turn-already-idle",
    });
    await manager.waitForAgentRunStart(agent.id);

    const replacementStream = await manager.replaceAgentRun(agent.id, "replacement prompt");
    const replacementEvents = (async () => {
      const events = [];
      for await (const event of replacementStream) {
        events.push(event);
      }
      return events;
    })();

    await expect
      .poll(() => appServer.requests().filter((message) => message.method === "turn/start").length)
      .toBe(2);
    appServer.startsTurn({ threadId: "thread-1", turnId: "native-turn-replacement" });
    appServer.completeTurn({ threadId: "thread-1" });

    await expect(firstRun).resolves.toMatchObject({ canceled: true });
    await expect(replacementEvents).resolves.toContainEqual(
      expect.objectContaining({ type: "turn_completed" }),
    );
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("early stdout EOF retains the real failure and permits only an explicit follow-up turn", async () => {
  const initial = createFakeCodexAppServer();
  const replacement = createFakeCodexAppServer();
  const servers = [initial, replacement];
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: process.cwd(), modeId: "auto", model: "gpt-5.4" },
    null,
    logger,
    async () => {
      const server = servers.shift();
      if (!server) throw new Error("Unexpected extra Codex spawn");
      return server.child;
    },
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    const run = session.run("inspect once without replaying side effects");
    await initial.waitForTurnStart();
    initial.startsTurn({ threadId: "thread-1", turnId: "early-eof-turn" });
    const rejection = expect(run).rejects.toThrow(/code 23[\s\S]*late provider diagnostic/);
    const ended = new Promise<void>((resolve) => initial.child.stdout.once("end", resolve));
    initial.child.stdout.end();
    await ended;
    initial.child.stderr.write("late provider diagnostic");
    initial.child.emit("exit", 23, null);
    initial.child.emit("close", 23, null);
    await rejection;
    expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(1);
    expect(initial.requests().filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(
      replacement.requests().filter((request) => request.method === "turn/start"),
    ).toHaveLength(0);

    const followup = session.run("new explicit follow-up");
    await replacement.waitForTurnStart();
    replacement.startsTurn({ threadId: "thread-1", turnId: "follow-up-turn" });
    replacement.completeTurn();
    await expect(followup).resolves.toMatchObject({ sessionId: "thread-1" });
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(1);
  } finally {
    await session.close();
    initial.child.stderr.end();
    replacement.child.stdout.end();
    replacement.child.stderr.end();
  }
});

test("intentional agent close stays clean while a Codex turn is active", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-close-"));
  const appServer = createFakeCodexAppServer();
  const manager = new AgentManager({
    clients: { codex: new ProcessExitCodexClient([appServer]) },
    logger,
  });
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    const run = manager.streamAgent(agent.id, "keep working");
    const drainRun = (async () => {
      const runEvents = [];
      for await (const event of run) {
        runEvents.push(event);
      }
      return runEvents;
    })();
    const turnStart = await appServer.waitForTurnStart();
    appServer.startsTurn({ threadId: String(turnStart.threadId), turnId: "native-turn-1" });
    await manager.waitForAgentRunStart(agent.id);

    await manager.closeAgent(agent.id);

    await expect(drainRun).resolves.toContainEqual(
      expect.objectContaining({ type: "turn_canceled", reason: "agent closed" }),
    );
    expect(
      events.filter((event) => event.type === "agent_stream" && event.event.type === "turn_failed"),
    ).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent_state",
        agent: expect.objectContaining({ id: agent.id, lifecycle: "closed" }),
      }),
    );
  } finally {
    unsubscribe();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("idle Codex app-server exit reconnects without publishing a failed turn", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-idle-exit-"));
  const exitedAppServer = createFakeCodexAppServer();
  const replacementAppServer = createFakeCodexAppServer();
  const manager = new AgentManager({
    clients: {
      codex: new ProcessExitCodexClient([exitedAppServer, replacementAppServer]),
    },
    logger,
  });
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
  let agentId: string | null = null;

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;

    exitedAppServer.child.emit("exit", 17, null);

    await expect.poll(() => manager.getAgent(agent.id)?.lifecycle).toBe("idle");
    expect(
      events.filter((event) => event.type === "agent_stream" && event.event.type === "turn_failed"),
    ).toHaveLength(0);

    const run = manager.runAgent(agent.id, "continue after reconnect");
    const turnStart = await replacementAppServer.waitForTurnStart();
    replacementAppServer.startsTurn({
      threadId: String(turnStart.threadId),
      turnId: "native-turn-2",
    });
    replacementAppServer.completeTurn({ threadId: String(turnStart.threadId) });

    await expect(run).resolves.toMatchObject({ sessionId: "thread-1" });
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    unsubscribe();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("failed reconnect preserves manager events for a later successful run", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-reconnect-failure-"));
  const exitedAppServer = createFakeCodexAppServer();
  const failedReconnect = createFakeCodexAppServer({
    initialize: async () => {
      throw new Error("reconnect failed");
    },
  });
  const successfulReconnect = createFakeCodexAppServer();
  const manager = new AgentManager({
    clients: {
      codex: new ProcessExitCodexClient([exitedAppServer, failedReconnect, successfulReconnect]),
    },
    logger,
  });
  let agentId: string | null = null;

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;
    exitedAppServer.child.emit("exit", 17, null);

    await expect(manager.runAgent(agent.id, "first reconnect")).rejects.toThrow("reconnect failed");

    const run = manager.runAgent(agent.id, "second reconnect");
    const turnStart = await successfulReconnect.waitForTurnStart();
    successfulReconnect.startsTurn({
      threadId: String(turnStart.threadId),
      turnId: "native-turn-3",
    });
    successfulReconnect.completeTurn({ threadId: String(turnStart.threadId) });

    await expect(run).resolves.toMatchObject({ sessionId: "thread-1" });
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("unexpected exit fails an autonomous Codex turn", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-autonomous-exit-"));
  const appServer = createFakeCodexAppServer();
  const manager = new AgentManager({
    clients: { codex: new ProcessExitCodexClient([appServer]) },
    logger,
  });
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
  let agentId: string | null = null;

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;
    appServer.startsTurn({ threadId: "thread-1", turnId: "autonomous-turn" });
    await expect.poll(() => manager.getAgent(agent.id)?.lifecycle).toBe("running");

    appServer.child.stderr.write("autonomous provider crashed");
    appServer.child.emit("exit", 23, null);

    await expect.poll(() => manager.getAgent(agent.id)?.lifecycle).toBe("error");
    expect(manager.getAgent(agent.id)?.lastError).toBe(
      "Codex app-server exited with code 23 and signal null\nautonomous provider crashed",
    );
    expect(
      events.filter((event) => event.type === "agent_stream" && event.event.type === "turn_failed"),
    ).toHaveLength(1);
  } finally {
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    unsubscribe();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("provider permissions do not survive an unexpected exit and reconnect", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-permission-exit-"));
  const exitedAppServer = createFakeCodexAppServer();
  const replacementAppServer = createFakeCodexAppServer();
  const manager = new AgentManager({
    clients: {
      codex: new ProcessExitCodexClient([exitedAppServer, replacementAppServer]),
    },
    logger,
  });
  let agentId: string | null = null;

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;

    const failedRun = manager.runAgent(agent.id, "run a command");
    const failedTurnStart = await exitedAppServer.waitForTurnStart();
    const failedThreadId = String(failedTurnStart.threadId);
    exitedAppServer.startsTurn({ threadId: failedThreadId, turnId: "native-turn-1" });
    exitedAppServer.requestCommandApproval({
      itemId: "stale-command",
      threadId: failedThreadId,
      turnId: "native-turn-1",
      command: "git status",
      cwd: workdir,
      reason: "confirm command",
    });
    await expect
      .poll(() => manager.getPendingPermissions(agent.id).map((request) => request.id))
      .toEqual(["permission-stale-command"]);

    exitedAppServer.child.emit("exit", 17, null);

    await expect(failedRun).rejects.toThrow("Codex app-server exited with code 17");
    expect(manager.getPendingPermissions(agent.id)).toEqual([]);

    const recoveredRun = manager.runAgent(agent.id, "continue after reconnect");
    const recoveredTurnStart = await replacementAppServer.waitForTurnStart();
    const recoveredThreadId = String(recoveredTurnStart.threadId);
    replacementAppServer.startsTurn({
      threadId: recoveredThreadId,
      turnId: "native-turn-2",
    });
    replacementAppServer.requestCommandApproval({
      itemId: "new-command",
      threadId: recoveredThreadId,
      turnId: "native-turn-2",
      command: "git diff",
      cwd: workdir,
      reason: "confirm command",
    });
    await expect
      .poll(() => manager.getPendingPermissions(agent.id).map((request) => request.id))
      .toEqual(["permission-new-command"]);

    await manager.respondToPermission(agent.id, "permission-new-command", {
      behavior: "allow",
    });

    expect(manager.getPendingPermissions(agent.id)).toEqual([]);
    replacementAppServer.completeTurn({ threadId: recoveredThreadId });
    await expect(recoveredRun).resolves.toMatchObject({ sessionId: "thread-1" });
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("idle provider exit preserves a synthetic plan approval across reconnect", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-plan-exit-"));
  const exitedAppServer = createFakeCodexAppServer();
  const replacementAppServer = createFakeCodexAppServer();
  const manager = new AgentManager({
    clients: {
      codex: new ProcessExitCodexClient([exitedAppServer, replacementAppServer]),
    },
    logger,
  });
  let agentId: string | null = null;

  try {
    const agent = await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
        modeId: "auto",
        model: "gpt-5.4",
        featureValues: { plan_mode: true },
      },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;

    const planRun = manager.runAgent(agent.id, "make a plan");
    const planTurnStart = await exitedAppServer.waitForTurnStart();
    const planThreadId = String(planTurnStart.threadId);
    exitedAppServer.startsTurn({ threadId: planThreadId, turnId: "plan-turn" });
    exitedAppServer.updatesPlan({
      threadId: planThreadId,
      steps: ["Inspect the provider lifecycle", "Implement the fix"],
    });
    exitedAppServer.completeTurn({ threadId: planThreadId });
    await expect(planRun).resolves.toMatchObject({ sessionId: "thread-1" });
    const [planApproval] = manager.getPendingPermissions(agent.id);
    expect(planApproval).toMatchObject({
      name: "CodexPlanApproval",
      kind: "plan",
    });

    exitedAppServer.child.emit("exit", 17, null);

    await expect.poll(() => manager.getAgent(agent.id)?.lifecycle).toBe("idle");
    expect(manager.getPendingPermissions(agent.id)).toEqual([planApproval]);
    const approval = await manager.respondToPermission(agent.id, planApproval!.id, {
      behavior: "allow",
      selectedActionId: "implement",
    });
    expect(approval).toMatchObject({
      followUpPrompt: expect.stringContaining("Implement the fix"),
    });

    const implementationRun = manager.runAgent(agent.id, approval!.followUpPrompt!);
    const implementationTurnStart = await replacementAppServer.waitForTurnStart();
    const implementationThreadId = String(implementationTurnStart.threadId);
    replacementAppServer.startsTurn({
      threadId: implementationThreadId,
      turnId: "implementation-turn",
    });
    replacementAppServer.completeTurn({ threadId: implementationThreadId });
    await expect(implementationRun).resolves.toMatchObject({ sessionId: "thread-1" });
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("concurrent session APIs share one reconnect after an idle provider exit", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-concurrent-reconnect-"));
  const appServers = [
    createFakeCodexAppServer(),
    createFakeCodexAppServer(),
    createFakeCodexAppServer(),
  ];
  let spawnCount = 0;
  let releaseReconnect: (() => void) | undefined;
  const reconnectGate = new Promise<void>((resolve) => {
    releaseReconnect = resolve;
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
    null,
    logger,
    async () => {
      const appServer = appServers[spawnCount];
      if (!appServer) {
        throw new Error("No fake Codex app-server available");
      }
      spawnCount += 1;
      if (spawnCount > 1) {
        await reconnectGate;
      }
      return appServer.child;
    },
  );

  try {
    await session.connect();
    appServers[0]!.child.emit("exit", 17, null);

    const runtimeInfo = session.getRuntimeInfo();
    const turnStart = session.startTurn("continue after reconnect");
    releaseReconnect?.();

    await expect(runtimeInfo).resolves.toMatchObject({ provider: "codex" });
    await expect(turnStart).resolves.toMatchObject({ turnId: expect.any(String) });
    expect(spawnCount - 1).toBe(1);
  } finally {
    releaseReconnect?.();
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("stdout EOF disposes its live wrapper before reconnecting", async () => {
  const initial = createFakeCodexAppServer();
  const replacement = createFakeCodexAppServer();
  let spawnCount = 0;
  let killCount = 0;
  const kill = initial.child.kill.bind(initial.child);
  initial.child.kill = (signal) => {
    killCount += 1;
    return kill(signal);
  };
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: process.cwd(), modeId: "auto", model: "gpt-5.4" },
    null,
    logger,
    async () => {
      spawnCount += 1;
      if (spawnCount === 1) return initial.child;
      expect(killCount).toBe(1);
      return replacement.child;
    },
  );
  try {
    await session.connect();
    const ended = new Promise<void>((resolve) => initial.child.stdout.once("end", resolve));
    initial.child.stdout.end();
    await ended;
    await session.startTurn("continue with a fresh transport");
    expect(spawnCount).toBe(2);
    expect(killCount).toBe(1);
    initial.assertNoErrors();
    replacement.assertNoErrors();
  } finally {
    await session.close();
    initial.child.stderr.end();
    replacement.child.stdout.end();
    replacement.child.stderr.end();
  }
});

test("final completion drains after process exit before reconnecting an active session", async () => {
  const initial = createFakeCodexAppServer();
  const replacement = createFakeCodexAppServer();
  let spawnCount = 0;
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: process.cwd(), modeId: "auto", model: "gpt-5.4" },
    null,
    logger,
    async () => (++spawnCount === 1 ? initial.child : replacement.child),
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    const run = session.run("finish at the process boundary");
    await initial.waitForTurnStart();
    initial.startsTurn({ threadId: "thread-1", turnId: "native-draining-turn" });
    initial.child.emit("exit", 0, null);
    const runtimeInfo = session.getRuntimeInfo();
    initial.completeTurn();
    initial.child.stdout.end();

    await expect(run).resolves.toMatchObject({ sessionId: "thread-1" });
    await expect(runtimeInfo).resolves.toMatchObject({ provider: "codex" });
    expect(spawnCount).toBe(2);
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(0);
    initial.assertNoErrors();
    replacement.assertNoErrors();
  } finally {
    await session.close();
    initial.child.stderr.end();
    replacement.child.stdout.end();
    replacement.child.stderr.end();
  }
});

test("session close disposes a provider that arrives from an in-flight reconnect", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-close-reconnect-"));
  const initialAppServer = createFakeCodexAppServer();
  const lateAppServer = createFakeCodexAppServer();
  let spawnCount = 0;
  let markReconnectSpawned: (() => void) | undefined;
  const reconnectSpawned = new Promise<void>((resolve) => {
    markReconnectSpawned = resolve;
  });
  let releaseReconnect: (() => void) | undefined;
  const reconnectGate = new Promise<void>((resolve) => {
    releaseReconnect = resolve;
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
    null,
    logger,
    async () => {
      spawnCount += 1;
      if (spawnCount === 1) {
        return initialAppServer.child;
      }
      markReconnectSpawned?.();
      await reconnectGate;
      return lateAppServer.child;
    },
  );
  const events: AgentManagerEvent[] = [];
  session.subscribe((event) => {
    events.push({ type: "agent_stream", agentId: "test-agent", event });
  });
  const lateExit = new Promise<void>((resolve) => {
    lateAppServer.child.once("exit", () => resolve());
  });

  try {
    await session.connect();
    initialAppServer.child.emit("exit", 17, null);

    const turnStart = session.startTurn("continue after reconnect");
    await reconnectSpawned;
    await session.close();
    releaseReconnect?.();

    await expect(turnStart).rejects.toThrow("Codex app-server session is closed");
    await expect(lateExit).resolves.toBeUndefined();
    expect(events.filter((event) => event.event.type === "turn_failed")).toHaveLength(0);

    await expect(session.connect()).rejects.toThrow("Codex app-server session is closed");
    expect(spawnCount).toBe(2);
  } finally {
    releaseReconnect?.();
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

const IDLE_RELEASE_MS = 30 * 60_000;

interface IdleCodexSession {
  session: CodexAppServerAgentSession;
  initial: FakeCodexAppServer;
  replacement: FakeCodexAppServer;
  events: AgentStreamEvent[];
  runTurn(server: FakeCodexAppServer, prompt: string, during?: () => void): Promise<void>;
  passTime(ms: number): void;
}

async function withIdleCodexSession(
  runScenario: (fixture: IdleCodexSession) => Promise<void>,
  options: { logger?: Logger } = {},
): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] });
  const initial = createFakeCodexAppServer();
  const replacement = createFakeCodexAppServer();
  const servers = [initial, replacement];
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: process.cwd(), modeId: "auto", model: "gpt-5.4" },
    null,
    options.logger ?? logger,
    async () => {
      const server = servers.shift();
      if (!server) throw new Error("Unexpected extra Codex spawn");
      return server.child;
    },
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  const turnStarts = (server: FakeCodexAppServer) =>
    server.requests().filter((request) => request.method === "turn/start").length;
  try {
    await runScenario({
      session,
      initial,
      replacement,
      events,
      async runTurn(server, prompt, during) {
        const expectedStarts = turnStarts(server) + 1;
        const run = session.run(prompt);
        await expect.poll(() => turnStarts(server)).toBe(expectedStarts);
        server.startsTurn({ threadId: "thread-1", turnId: `turn-${expectedStarts}` });
        during?.();
        server.completeTurn();
        await run;
      },
      passTime(ms) {
        vi.setSystemTime(Date.now() + ms);
      },
    });
    initial.assertNoErrors();
    replacement.assertNoErrors();
  } finally {
    await session.close();
    vi.useRealTimers();
    for (const server of [initial, replacement]) {
      server.child.stdout.end();
      server.child.stderr.end();
    }
  }
}

test("an idle Codex session gives up its app-server and resumes the thread on the next prompt", async () => {
  await withIdleCodexSession(
    async ({ session, initial, replacement, events, runTurn, passTime }) => {
      await session.setMode("full-access");
      await session.setThinkingOption("high");
      await runTurn(initial, "first prompt");
      const runtimeInfo = await session.getRuntimeInfo();
      const killed = vi.spyOn(initial.child, "kill");

      expect(await session.releaseIdleRuntime(IDLE_RELEASE_MS)).toBe(false);
      expect(killed).not.toHaveBeenCalled();

      passTime(IDLE_RELEASE_MS);
      const eventsBeforeRelease = [...events];
      expect(await session.releaseIdleRuntime(IDLE_RELEASE_MS)).toBe(true);

      // Nothing tells subscribers the conversation ended, and reading its state
      // does not bring the process back.
      expect(killed).toHaveBeenCalled();
      expect(events).toEqual(eventsBeforeRelease);
      expect(await session.getCurrentMode()).toBe("full-access");
      expect(await session.getRuntimeInfo()).toEqual(runtimeInfo);
      expect(session.describePersistence()).toMatchObject({ sessionId: "thread-1" });
      expect(session.getPendingPermissions()).toEqual([]);
      expect(replacement.requests()).toEqual([]);
      expect(await session.releaseIdleRuntime(IDLE_RELEASE_MS)).toBe(false);

      await runTurn(replacement, "second prompt");

      const methods = replacement.requests().map((request) => request.method);
      expect(methods).toContain("thread/resume");
      expect(methods).not.toContain("thread/start");
      expect(await replacement.waitForRequest("thread/resume")).toMatchObject({
        threadId: "thread-1",
      });
      // The restarted process runs the next turn with the same model, effort and permissions.
      const firstTurn = await initial.waitForTurnStart();
      const secondTurn = await replacement.waitForTurnStart();
      expect(firstTurn).toMatchObject({
        threadId: "thread-1",
        model: "gpt-5.4",
        effort: "high",
        approvalPolicy: "never",
      });
      expect({ ...secondTurn, input: null }).toEqual({ ...firstTurn, input: null });
      expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(2);
      expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(0);
    },
  );
});

test("a prompt sent while an idle Codex app-server is being released waits for it to exit", async () => {
  await withIdleCodexSession(async ({ session, initial, replacement, runTurn, passTime }) => {
    await runTurn(initial, "first prompt");
    passTime(IDLE_RELEASE_MS);
    let exited = false;
    initial.child.once("exit", () => {
      exited = true;
    });

    const release = session.releaseIdleRuntime(IDLE_RELEASE_MS);
    const followup = session.run("second prompt");
    await replacement.waitForRequest("initialize");
    expect(exited).toBe(true);
    await expect(release).resolves.toBe(true);

    await replacement.waitForTurnStart();
    replacement.startsTurn({ threadId: "thread-1", turnId: "turn-after-release" });
    replacement.completeTurn();
    await expect(followup).resolves.toMatchObject({ sessionId: "thread-1" });
  });
});

test("a Codex session with a turn in flight or no finished turn keeps its app-server", async () => {
  await withIdleCodexSession(async ({ session, initial, events, passTime }) => {
    // A thread that has not finished a turn may not be on disk for a new process.
    await session.connect();
    const killed = vi.spyOn(initial.child, "kill");
    passTime(IDLE_RELEASE_MS);
    expect(await session.releaseIdleRuntime(IDLE_RELEASE_MS)).toBe(false);

    const run = session.run("keep working");
    await initial.waitForTurnStart();
    initial.startsTurn({ threadId: "thread-1", turnId: "long-turn" });
    await expect.poll(() => events.at(-1)?.type).toBe("turn_started");
    passTime(IDLE_RELEASE_MS);
    expect(await session.releaseIdleRuntime(IDLE_RELEASE_MS)).toBe(false);

    initial.completeTurn();
    await run;
    expect(killed).not.toHaveBeenCalled();
  });
});

test("a Codex session that left a command running keeps its app-server", async () => {
  await withIdleCodexSession(async ({ session, initial, runTurn, passTime }) => {
    await runTurn(initial, "start the dev server", () => {
      initial.completesCommand({
        threadId: "thread-1",
        callId: "dev-server",
        command: "npm run dev",
        output: "Process running with session ID 7",
      });
    });
    const killed = vi.spyOn(initial.child, "kill");

    passTime(IDLE_RELEASE_MS);

    expect(await session.releaseIdleRuntime(IDLE_RELEASE_MS)).toBe(false);
    expect(killed).not.toHaveBeenCalled();
  });
});

const backgroundBuild = {
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "background-build",
  processId: "7",
  command: "npm run build",
};

function isCompletedBackgroundBuild(event: AgentStreamEvent): boolean {
  return (
    event.type === "timeline" &&
    event.item.type === "tool_call" &&
    event.item.callId === backgroundBuild.itemId &&
    event.item.status === "completed"
  );
}

test("a Codex session releases its app-server once the terminal it left running has exited", async () => {
  await withIdleCodexSession(async ({ session, initial, events, runTurn, passTime }) => {
    await runTurn(initial, "build in the background", () => {
      initial.startsTerminalCommand(backgroundBuild);
      initial.typesIntoTerminal({ ...backgroundBuild, text: "" });
    });
    const killed = vi.spyOn(initial.child, "kill");

    passTime(IDLE_RELEASE_MS);
    expect(await session.releaseIdleRuntime(IDLE_RELEASE_MS)).toBe(false);
    expect(killed).not.toHaveBeenCalled();

    // Codex reports the command when its process exits, long after the turn ended.
    initial.exitsTerminalCommand({ ...backgroundBuild, exitCode: 0 });
    await expect.poll(() => events.some(isCompletedBackgroundBuild)).toBe(true);
    passTime(IDLE_RELEASE_MS);
    expect(await session.releaseIdleRuntime(IDLE_RELEASE_MS)).toBe(true);
    expect(killed).toHaveBeenCalled();
  });
});

test("a Codex session keeps its app-server for a terminal it never wrote to", async () => {
  await withIdleCodexSession(async ({ session, initial, runTurn, passTime }) => {
    await runTurn(initial, "start the dev server", () => {
      initial.startsTerminalCommand({ ...backgroundBuild, command: "npm run dev" });
    });
    const killed = vi.spyOn(initial.child, "kill");

    passTime(IDLE_RELEASE_MS);

    expect(await session.releaseIdleRuntime(IDLE_RELEASE_MS)).toBe(false);
    expect(killed).not.toHaveBeenCalled();
  });
});

test("a write Codex reports after a terminal exited does not hold the app-server", async () => {
  await withIdleCodexSession(async ({ session, initial, runTurn, passTime }) => {
    await runTurn(initial, "run the build", () => {
      initial.startsTerminalCommand(backgroundBuild);
      initial.exitsTerminalCommand({ ...backgroundBuild, exitCode: 1 });
      initial.typesIntoTerminal({ ...backgroundBuild, text: "" });
    });

    passTime(IDLE_RELEASE_MS);

    expect(await session.releaseIdleRuntime(IDLE_RELEASE_MS)).toBe(true);
  });
});

test("an idle Codex app-server kept for a running terminal says why once", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const capturing = pino(
    { level: "info" },
    { write: (line: string) => lines.push(JSON.parse(line)) },
  );
  await withIdleCodexSession(
    async ({ session, initial, runTurn, passTime }) => {
      await runTurn(initial, "build in the background", () => {
        initial.startsTerminalCommand(backgroundBuild);
      });

      passTime(IDLE_RELEASE_MS);
      await session.releaseIdleRuntime(IDLE_RELEASE_MS);
      passTime(60_000);
      await session.releaseIdleRuntime(IDLE_RELEASE_MS);

      expect(
        lines
          .filter((line) => line.msg === "Kept idle Codex app-server running")
          .map(({ threadId, reason, processIds }) => ({ threadId, reason, processIds })),
      ).toEqual([{ threadId: "thread-1", reason: "terminal_running", processIds: ["7"] }]);
    },
    { logger: capturing },
  );
});

async function withIdleCodexAgent(
  runScenario: (fixture: {
    manager: AgentManager;
    agentId: string;
    initial: FakeCodexAppServer;
    replacement: FakeCodexAppServer;
    hooks: string[];
  }) => Promise<void>,
): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const workdir = mkdtempSync(join(tmpdir(), "codex-idle-release-"));
  const initial = createFakeCodexAppServer();
  const replacement = createFakeCodexAppServer();
  const hooks: string[] = [];
  const manager = new AgentManager({
    clients: { codex: new ProcessExitCodexClient([initial, replacement]) },
    idleRuntimeReleaseMs: IDLE_RELEASE_MS,
    pluginLifecycle: {
      emit: (name) => {
        hooks.push(name);
      },
      before: async (_name, request) => request,
    },
    logger,
  });
  let agentId: string | null = null;
  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;
    await runScenario({ manager, agentId, initial, replacement, hooks });
  } finally {
    manager.prepareForShutdown();
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    vi.useRealTimers();
    rmSync(workdir, { recursive: true, force: true });
  }
}

test("an idle Codex agent stays registered and idle while its app-server is released and restarted", async () => {
  await withIdleCodexAgent(async ({ manager, agentId, initial, replacement, hooks }) => {
    const first = manager.runAgent(agentId, "first prompt");
    await initial.waitForTurnStart();
    initial.startsTurn({ threadId: "thread-1", turnId: "turn-1" });
    initial.completeTurn();
    await first;
    await expect.poll(() => manager.getAgent(agentId)?.lifecycle).toBe("idle");
    await manager.flush();

    const killed = vi.spyOn(initial.child, "kill");
    const before = toAgentPayload(manager.getAgent(agentId)!);
    const events: AgentManagerEvent[] = [];
    const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
    hooks.length = 0;

    await vi.advanceTimersByTimeAsync(IDLE_RELEASE_MS - 60_000);
    expect(killed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await expect.poll(() => killed.mock.calls.length).toBeGreaterThan(0);

    // The conversation did not end: no state change, no stream event, no
    // agent.closed hook, and the same mode, model and unread flag as before.
    expect(events).toEqual([]);
    expect(hooks).toEqual([]);
    expect(toAgentPayload(manager.getAgent(agentId)!)).toEqual(before);
    expect(before).toMatchObject({
      status: "idle",
      currentModeId: "auto",
      model: "gpt-5.4",
      requiresAttention: true,
      attentionReason: "finished",
    });
    expect(replacement.requests()).toEqual([]);

    const second = manager.runAgent(agentId, "second prompt");
    await replacement.waitForTurnStart();
    replacement.startsTurn({ threadId: "thread-1", turnId: "turn-2" });
    replacement.completeTurn();
    await expect(second).resolves.toMatchObject({ sessionId: "thread-1" });
    expect(await replacement.waitForRequest("thread/resume")).toMatchObject({
      threadId: "thread-1",
    });
    await expect.poll(() => manager.getAgent(agentId)?.lifecycle).toBe("idle");
    expect(hooks).not.toContain("agent.closed");
    unsubscribe();
    initial.assertNoErrors();
    replacement.assertNoErrors();
  });
});

test("a Codex agent mid-turn keeps its app-server past the idle window", async () => {
  await withIdleCodexAgent(async ({ manager, agentId, initial, replacement }) => {
    const killed = vi.spyOn(initial.child, "kill");
    const run = manager.runAgent(agentId, "keep working");
    const turnStart = await initial.waitForTurnStart();
    initial.startsTurn({ threadId: String(turnStart.threadId), turnId: "long-turn" });
    await manager.waitForAgentRunStart(agentId);

    await vi.advanceTimersByTimeAsync(IDLE_RELEASE_MS + 2 * 60_000);

    expect(killed).not.toHaveBeenCalled();
    expect(replacement.requests()).toEqual([]);
    initial.completeTurn();
    await run;
  });
});
