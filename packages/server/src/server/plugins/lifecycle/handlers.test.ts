import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginHookHandlers } from "./index.js";

const paseo = createPaseoApi(
  new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "lifecycle-unit" }),
);

test("removing an old registration twice preserves a newer registration for the same hook", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const remove = hooks.addHook("workspace.create.prepare", async ({ request }) => {
    return { ...request, title: "old" };
  });
  remove();
  hooks.addHook("workspace.create.prepare", async ({ request }) => {
    return { ...request, title: "new" };
  });
  remove();
  const output = await hooks.invoke(
    "operation",
    "workspace.create.prepare",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  expect(output).toEqual({ source: { kind: "directory", path: "/project" }, title: "new" });
});

test("before hooks compose returned requests and preserve the original input", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("workspace.create.prepare", async ({ request }) => {
    return { ...request, title: "first" };
  });
  hooks.addHook("workspace.create.prepare", async () => {
    return;
  });
  hooks.addHook("workspace.create.prepare", async ({ request }) => {
    return { ...request, title: request.title + ":second" };
  });
  const input = { source: { kind: "directory", path: "/project" } };
  expect(await hooks.invoke("operation", "workspace.create.prepare", input, paseo)).toEqual({
    source: { kind: "directory", path: "/project" },
    title: "first:second",
  });
  expect(input).toEqual({ source: { kind: "directory", path: "/project" } });
});

test("teardown aborts an active callback and removes its registrations", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("workspace.create.prepare", async (_input, context) => {
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => {
          reject(new Error("Hook aborted"));
        },
        { once: true },
      );
    });
  });
  const invocation = hooks.invoke(
    "operation",
    "workspace.create.prepare",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  hooks.close();
  await expect(invocation).rejects.toThrow("Hook aborted");
  expect(hooks.catalog()).toEqual([]);
});

test("session-open hooks reject changes to session identity instead of silently ignoring them", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("agent.open.prepare", async ({ request }) => {
    return { ...request, provider: "another-provider" };
  });
  await expect(
    hooks.invoke(
      "operation",
      "agent.open.prepare",
      {
        agentId: "agent",
        workspaceId: "workspace",
        provider: "claude",
        cwd: "/project",
        reason: "resume",
        purpose: "interactive",
        env: {},
        title: null,
        labels: {},
        tools: [],
        mcpServers: {},
      },
      paseo,
    ),
  ).rejects.toThrow("agent.open.prepare hooks can only change env");
});

test.each([{ title: "Changed" }, { labels: { changed: "true" } }])(
  "session-open targeting metadata is read-only: %j",
  async (patch) => {
    const hooks = new PluginHookHandlers(() => {});
    hooks.addHook("agent.open.prepare", async ({ request }) => ({ ...request, ...patch }));
    await expect(
      hooks.invoke(
        "operation",
        "agent.open.prepare",
        {
          agentId: "agent",
          workspaceId: null,
          provider: "codex",
          cwd: "/project",
          title: "Original",
          labels: {},
          tools: [],
          mcpServers: {},
          env: {},
          reason: "create",
          purpose: "interactive",
        },
        paseo,
      ),
    ).rejects.toThrow("agent.open.prepare hooks can only change env, tools, and mcpServers");
  },
);

test("new prepare registrations compose with legacy registrations in registration order", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", ({ request }) => ({ ...request, title: "legacy" }));
  hooks.addHook("workspace.create.prepare", async ({ request }) => ({
    ...request,
    title: request.title + ":new",
  }));
  hooks.before("workspace.create", ({ request }) => ({
    ...request,
    title: request.title + ":last",
  }));
  expect(
    await hooks.invoke(
      "operation",
      "workspace.create.prepare",
      {
        source: { kind: "directory", path: "/project" },
      },
      paseo,
    ),
  ).toEqual({ source: { kind: "directory", path: "/project" }, title: "legacy:new:last" });
});

test.each(["agent.session_open", "nonsense"])(
  "addHook rejects unsupported name %s at registration",
  (name) => {
    const hooks = new PluginHookHandlers(() => {});
    // @ts-expect-error Runtime validation also protects untyped plugins.
    expect(() => hooks.addHook(name, async () => {})).toThrow(name);
  },
);

test.each([
  ["workspace.create", "workspace.create.prepare"],
  ["workspace.created", "workspace.create.completed"],
  ["workspace.archived", "workspace.archive.completed"],
  ["agent.create", "agent.create.prepare"],
  ["agent.created", "agent.create.completed"],
  ["agent.session_open", "agent.open.prepare"],
  ["agent.closed", "agent.close.completed"],
  ["agent.archived", "agent.archive.completed"],
  ["agent.turn_started", "agent.turn.started"],
  ["agent.turn_ended", "agent.turn.completed"],
  ["agent.permission_requested", "agent.permission.started"],
  ["agent.permission_resolved", "agent.permission.completed"],
] as const)("legacy %s registers only %s across the process boundary", (oldName, newName) => {
  const hooks = new PluginHookHandlers(() => {});
  const handler = async () => {};
  const remove =
    oldName === "workspace.create" || oldName === "agent.create" || oldName === "agent.session_open"
      ? hooks.before(oldName, handler)
      : hooks.on(oldName, handler);
  hooks.addHook(newName, async () => {});
  expect(hooks.catalog()).toEqual([newName]);
  remove();
  expect(hooks.catalog()).toEqual([newName]);
  hooks.close();
  expect(hooks.catalog()).toEqual([]);
});

test("legacy notifications and addHook share payloads, registration order, and cleanup", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const received: unknown[] = [];
  const remove = hooks.on("workspace.created", (event) => {
    received.push(["old", event]);
  });
  hooks.addHook("workspace.create.completed", async (event) => {
    received.push(["new", event]);
  });
  const payload = {
    workspace: {
      id: "workspace",
      projectId: "project",
      cwd: "/project",
      name: null,
      archivedAt: null,
    },
  };
  await hooks.invoke("first", "workspace.create.completed", payload, paseo);
  remove();
  remove();
  await hooks.invoke("second", "workspace.create.completed", payload, paseo);
  expect(received).toEqual([
    ["old", payload],
    ["new", payload],
    ["new", payload],
  ]);
});
