import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import {
  createCodexAppServerChildProcess,
  createFakeCodexAppServer,
} from "./test-utils/fake-app-server.js";
import { CodexAppServerClient } from "./app-server-transport.js";

describe("Codex app-server transport", () => {
  test("ignores non-JSON stdout lines without dropping pending requests", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());

    const request = client.request("model/list", {});
    child.stdout.write("Codex ha iniciado en modo localizado\n");
    child.stdout.write('{"id":1,"result":{"data":[]}}\n');

    await expect(request).resolves.toEqual({ data: [] });
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });

  test("keeps a JSON message intact when it contains raw U+2028/U+2029", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());

    const request = client.request("thread/resume", {});
    const text = "a\u2028b\u2029c\u0085d";
    // Codex does not escape U+2028/U+2029 in JSON output, so write them raw.
    const message = `{"id":1,"result":{"text":"${text}"}}\n`;
    const bytes = Buffer.from(message, "utf8");
    // Split mid-way (inside a multi-byte character) to exercise chunk boundaries.
    child.stdout.write(bytes.subarray(0, 28));
    child.stdout.write(bytes.subarray(28));

    await expect(request).resolves.toEqual({ text });
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });

  test("reads a multi-megabyte JSON message arriving in 64 KB chunks", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());

    const request = client.request("thread/resume", {});
    // A resumed long thread arrives as one large line, split into 64 KB stdout chunks.
    const text = "x".repeat(32 * 1024 * 1024);
    const bytes = Buffer.from(`{"id":1,"result":{"text":"${text}"}}\n`, "utf8");
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      child.stdout.write(bytes.subarray(offset, offset + chunkSize));
    }

    await expect(request).resolves.toEqual({ text });
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });

  test("dispose rejects pending requests instead of leaving them hanging", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());

    const request = client.request("initialize", {});
    await client.dispose();

    await expect(request).rejects.toThrow("Codex app-server client is closed");
  });

  test.each(["stdin", "stdout", "stderr"] as const)(
    "%s errors reject pending requests and report termination once",
    async (streamName) => {
      const child = createCodexAppServerChildProcess();
      const client = new CodexAppServerClient(child, createTestLogger());
      const onTermination = vi.fn();
      const onNotification = vi.fn();
      client.setUnexpectedTerminationHandler(onTermination);
      client.setNotificationHandler(onNotification);
      const request = client.request("initialize", {});
      const rejection = expect(request).rejects.toThrow("broken pipe");
      const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });

      expect(() => child[streamName].emit("error", error)).not.toThrow();
      await rejection;
      child.emit("exit", 1, null);
      child.emit("close", 1, null);
      child.stdout.write('{"method":"turn/completed","params":{}}\n');
      expect(onTermination).toHaveBeenCalledExactlyOnceWith(error);
      expect(onNotification).not.toHaveBeenCalled();
      await expect(client.request("model/list", {})).rejects.toThrow("client is closed");
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
    },
  );

  test.each(["end", "close"] as const)(
    "stdout %s rejects pending requests even when the child stays alive",
    async (event) => {
      const child = createCodexAppServerChildProcess();
      const client = new CodexAppServerClient(child, createTestLogger());
      const onTermination = vi.fn();
      client.setUnexpectedTerminationHandler(onTermination);
      const request = client.request("initialize", {});
      const rejection = expect(request).rejects.toThrow("stdout closed");

      child.stdout.emit(event);

      await rejection;
      expect(onTermination).toHaveBeenCalledOnce();
      child.emit("close", 0, null);
      expect(onTermination).toHaveBeenCalledOnce();
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
    },
  );

  test("synchronous stdin write failures reject the returned request and settle transport", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const onTermination = vi.fn();
    client.setUnexpectedTerminationHandler(onTermination);
    const error = new Error("synchronous broken pipe");
    const write = vi.spyOn(child.stdin, "write").mockImplementationOnce(() => {
      throw error;
    });
    try {
      await expect(client.request("initialize", {})).rejects.toBe(error);
      await client.waitForTermination();
      expect(client.isClosed).toBe(true);
      expect(onTermination).toHaveBeenCalledExactlyOnceWith(error);
    } finally {
      write.mockRestore();
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
    }
  });

  test("a closed stdin rejects requests without attempting an invalid write", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    child.stdin.end();
    await expect(client.request("initialize", {})).rejects.toThrow("stdin is closed");
    expect(client.isClosed).toBe(true);
    child.stdout.end();
    child.stderr.end();
  });

  test.each(["\n", ""])(
    "drains final stdout after child exit, including an EOF-delimited response %j",
    async (lineEnding) => {
      const child = createCodexAppServerChildProcess();
      const client = new CodexAppServerClient(child, createTestLogger());
      const events: string[] = [];
      client.setUnexpectedTerminationHandler(() => events.push("terminated"));
      client.setNotificationHandler((method) => events.push(method));
      const request = client.request("turn/start", {});
      expect(client.isClosed).toBe(false);

      child.emit("exit", 0, null);
      expect(client.isClosed).toBe(true);
      expect(events).toEqual([]);
      await expect(client.request("model/list", {})).rejects.toThrow("app-server exited");
      child.stdout.write('{"method":"turn/completed","params":{}}\n');
      const ended = new Promise<void>((resolve) => child.stdout.once("end", resolve));
      child.stdout.end(`{"id":1,"result":{"ok":true}}${lineEnding}`);

      await expect(request).resolves.toEqual({ ok: true });
      await ended;
      await client.waitForTermination();
      expect(events).toEqual(["turn/completed", "terminated"]);
      child.emit("close", 0, null);
      expect(events).toEqual(["turn/completed", "terminated"]);
      child.stderr.end();
      child.stdin.end();
    },
  );

  test("bounds stdout drain when an exited wrapper leaves its pipe open", async () => {
    vi.useFakeTimers();
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const onTermination = vi.fn();
    client.setUnexpectedTerminationHandler(onTermination);
    const request = client.request("initialize", {});
    const rejection = expect(request).rejects.toThrow("exited with code 17");
    try {
      child.emit("exit", 17, null);
      await vi.advanceTimersByTimeAsync(999);
      expect(onTermination).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(onTermination).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
    }
  });

  test("intentional disposal suppresses late stream errors and output", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const onTermination = vi.fn();
    const onNotification = vi.fn();
    client.setUnexpectedTerminationHandler(onTermination);
    client.setNotificationHandler(onNotification);
    const request = client.request("initialize", {});
    const rejection = expect(request).rejects.toThrow("client is closed");

    await client.dispose();
    await rejection;
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      expect(() => stream.emit("error", new Error("late pipe error"))).not.toThrow();
    }
    child.stdout.write('{"method":"turn/completed","params":{}}\n');
    child.stdout.end();
    child.stderr.end();
    expect(onTermination).not.toHaveBeenCalled();
    expect(onNotification).not.toHaveBeenCalled();
  });

  test("dispose rejects until the child has actually exited", async () => {
    vi.useFakeTimers();
    const child = createCodexAppServerChildProcess();
    child.kill = () => true;
    const client = new CodexAppServerClient(child, createTestLogger());
    try {
      for (let i = 0; i < 2; i++) {
        const closing = expect(client.dispose()).rejects.toThrow(
          "did not report exit after SIGKILL",
        );
        await vi.advanceTimersByTimeAsync(3_000);
        await closing;
      }
      child.exitCode = 0;
      child.emit("exit", 0, null);
      await expect(client.dispose()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      child.stdout.end();
      child.stderr.end();
    }
  });

  test.each([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
    "tool/requestUserInput",
  ])("answers server-initiated %s requests through registered handlers", async (method) => {
    const codex = createFakeCodexAppServer();
    const client = new CodexAppServerClient(codex.child, createTestLogger());
    const handlerCalls: unknown[] = [];
    client.setRequestHandler(method, async (params) => {
      handlerCalls.push(params);
      return { ok: true };
    });

    const response = codex.nextResponse();
    codex.child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method, params: {} })}\n`);

    await expect(response).resolves.toBe('{"id":7,"result":{"ok":true}}\n');
    expect(handlerCalls).toEqual([{}]);
    codex.child.stdout.end();
    codex.child.stderr.end();
    codex.child.stdin.end();
  });

  test("forks a Codex thread through thread/fork", async () => {
    const codex = createFakeCodexAppServer({
      "thread/fork": (params) => ({
        thread: {
          id: "forked-thread",
          sessionId: "forked-session",
          forkedFromId: (params as { threadId?: string }).threadId,
          turns: [],
        },
        model: "gpt-5.4",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace/project",
        runtimeWorkspaceRoots: [],
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: null,
        sandbox: { type: "workspaceWrite", networkAccess: false },
        activePermissionProfile: null,
        reasoningEffort: null,
      }),
    });
    const client = new CodexAppServerClient(codex.child, createTestLogger());

    const forked = await client.forkThread({
      threadId: "source-thread",
      cwd: "/workspace/project",
      excludeTurns: true,
    });

    expect(forked.thread.id).toBe("forked-thread");
    expect(forked.thread.forkedFromId).toBe("source-thread");
    codex.assertNoErrors();
    codex.child.stdout.end();
    codex.child.stderr.end();
    codex.child.stdin.end();
  });

  test("rolls back a Codex thread by N turns", async () => {
    const codex = createFakeCodexAppServer({
      "thread/rollback": (params) => {
        expect(params).toEqual({ threadId: "forked-thread", numTurns: 2 });
        return {
          thread: {
            id: "forked-thread",
            sessionId: "forked-session",
            turns: [{ id: "remaining-turn" }],
          },
        };
      },
    });
    const client = new CodexAppServerClient(codex.child, createTestLogger());

    const rolledBack = await client.rollbackThread({
      threadId: "forked-thread",
      numTurns: 2,
    });

    expect(rolledBack.thread.id).toBe("forked-thread");
    expect(rolledBack.thread.turns).toEqual([{ id: "remaining-turn" }]);
    codex.assertNoErrors();
    codex.child.stdout.end();
    codex.child.stderr.end();
    codex.child.stdin.end();
  });
});
