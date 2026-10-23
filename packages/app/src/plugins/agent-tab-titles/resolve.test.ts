import { describe, expect, it, vi } from "vitest";
import type { PluginAgentTabTitleContext, PluginAgentTabTitleResult } from "@getpaseo/plugin/client";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { applyAgentTabTitle, resolveAgentTabTitle, selectAgentTabProjectLabel, selectAgentTabSidebarLabel } from "./resolve";

const context: PluginAgentTabTitleContext = {
  serverId: "host-a",
  workspaceId: "workspace-a",
  agentId: "agent-a",
  defaultLabel: "Saved title",
  sidebarLabel: "  결제 기능 개선 🧩  ",
  projectLabel: "Payments",
};

function installation(
  id: string,
  resolve: (context: PluginAgentTabTitleContext) => PluginAgentTabTitleResult,
  serverId = "host-a",
) {
  return {
    id,
    serverId,
    lifetime: new AbortController(),
    agentTabTitleResolvers: [{ id: "sync", resolve }],
  };
}

describe("agent tab title resolution", () => {
  it("passes two original lines to the tab while retaining the legacy combined label and panel state", () => {
    const titleLines = { primaryLabel: "  Payments 🧩  ", secondaryLabel: "main" };
    const plugin = installation("two-lines", () => titleLines);
    const resolved = resolveAgentTabTitle([plugin], context);
    expect(resolved).toEqual(titleLines);
    expect(resolved).not.toBe(titleLines);
    const descriptor = {
      label: "Saved agent title", tooltip: "Saved agent title", subtitle: "Codex subagent",
      icon: () => null, statusBucket: "running" as const, titleState: "loading" as const,
    };
    expect(applyAgentTabTitle(descriptor, resolved)).toEqual({
      ...descriptor, label: "  Payments 🧩  -main", tooltip: "  Payments 🧩  -main",
      titleState: "ready", titleLines,
    });
    expect(descriptor.label).toBe("Saved agent title");
  });

  it.each([
    { primaryLabel: "", secondaryLabel: "main" },
    { primaryLabel: "Payments", secondaryLabel: "" },
    { primaryLabel: "Payments", secondaryLabel: 1 },
    { primaryLabel: null, secondaryLabel: "main" },
  ])("declines an invalid structured title %j", (result) => {
    const plugin = installation("invalid-lines", () => null);
    Reflect.set(plugin.agentTabTitleResolvers[0], "resolve", () => result);
    expect(resolveAgentTabTitle([plugin], context)).toBeNull();
  });
  it("changes only label, default tooltip, and loading state for agent and subagent tabs", () => {
    const descriptor = {
      label: "Task description",
      tooltip: "Task description",
      subtitle: "Research · Codex subagent",
      titleState: "loading" as const,
      statusBucket: "running" as const,
      icon: () => null,
    };
    expect(applyAgentTabTitle(descriptor, context.sidebarLabel)).toEqual({
      ...descriptor,
      label: context.sidebarLabel,
      tooltip: context.sidebarLabel,
      titleState: "ready",
    });
    expect(applyAgentTabTitle(descriptor, null)).toBe(descriptor);
  });
  it("contains a rejected promise from a plugin that violates the synchronous contract", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = installation("invalid-async", () => null);
    Reflect.set(plugin.agentTabTitleResolvers[0], "resolve", async () => {
      throw new Error("Async failure");
    });
    expect(resolveAgentTabTitle([plugin], context)).toBeNull();
    await Promise.resolve();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      "[Plugins] Agent tab title resolver must be synchronous: host-a/invalid-async/sync",
      expect.any(Error),
    );
    warning.mockRestore();
  });
  it("preserves the exact sidebar string and makes the context immutable", () => {
    const plugin = installation("sync", (input) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(input).toEqual(context);
      return input.sidebarLabel;
    });
    expect(resolveAgentTabTitle([plugin], context)).toBe("  결제 기능 개선 🧩  ");
    expect(context.defaultLabel).toBe("Saved title");
  });

  it("does not invoke another host or an installation whose lifetime ended", () => {
    const otherHost = vi.fn(() => "Wrong host");
    const removed = vi.fn(() => "Removed plugin");
    const disposed = installation("removed", removed);
    disposed.lifetime.abort();
    const plugins = [installation("wrong-host", otherHost, "host-b"), disposed];
    expect(resolveAgentTabTitle(plugins, context)).toBeNull();
    expect(otherHost).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
  });

  it("uses plugin ID then registration ID order independently of setup order", () => {
    const later = installation("z-plugin", () => "Later plugin");
    const first = installation("a-plugin", () => null);
    first.agentTabTitleResolvers = [
      { id: "z-resolver", resolve: () => "Later resolver" },
      { id: "a-resolver", resolve: () => "First resolver" },
    ];
    expect(resolveAgentTabTitle([later, first], context)).toBe("First resolver");
    expect(first.agentTabTitleResolvers.map((item) => item.id)).toEqual([
      "z-resolver",
      "a-resolver",
    ]);
  });

  it("declines empty and invalid results and contains resolver exceptions", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invalid = installation("b-invalid", () => null);
    Reflect.set(invalid.agentTabTitleResolvers[0], "resolve", () => ({ label: "invalid" }));
    const plugins = [
      installation("a-error", () => {
        throw new Error("Plugin failed");
      }),
      invalid,
      installation("c-empty", () => ""),
      installation("d-decline", () => null),
    ];
    expect(resolveAgentTabTitle(plugins, context)).toBeNull();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      "[Plugins] Agent tab title resolver failed: host-a/a-error/sync",
      expect.any(Error),
    );
    warning.mockRestore();
  });
});

const workspace: WorkspaceDescriptor = {
  id: "workspace-a",
  projectId: "project-a",
  projectDisplayName: "Payments",
  projectRootPath: "/same/path",
  workspaceDirectory: "/same/path",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "  결제 기능 개선 🧩  ",
  title: "  결제 기능 개선 🧩  ",
  status: "done",
  statusEnteredAt: null,
  archivingAt: null,
  diffStat: null,
  scripts: [],
};

describe("agent tab sidebar label selection", () => {
  function session(branch: string | null = null) {
    const entry = {
      ...workspace,
      gitRuntime: {
        currentBranch: branch,
        isDirty: false,
        aheadOfOrigin: 0,
        behindOrigin: 0,
        baseRef: null,
        upstream: null,
      },
    };
    return {
      agents: new Map([["agent-a", { workspaceId: "workspace-a" }]]),
      agentDetails: new Map(),
      workspaces: new Map<string, WorkspaceDescriptor>([[workspace.id, entry]]),
    };
  }

  it("uses project custom name and updates independently of the workspace label", () => {
    const cached = session();
    expect(selectAgentTabProjectLabel({ session: cached, context })).toBe("Payments");
    cached.workspaces.set(workspace.id, { ...workspace, projectCustomName: "결제 프로젝트" });
    expect(selectAgentTabProjectLabel({ session: cached, context })).toBe("결제 프로젝트");
    expect(selectAgentTabSidebarLabel({ session: cached, context, workspaceTitleSource: "title" }))
      .toBe(workspace.name);
    expect(selectAgentTabProjectLabel({ session: undefined, context })).toBeNull();
    cached.agents.set(context.agentId, { workspaceId: "different-workspace" });
    expect(selectAgentTabProjectLabel({ session: cached, context })).toBeNull();
  });

  it("uses the same raw name and normalized branch fallback as the sidebar", () => {
    const cached = session("  feat/payments  ");
    expect(
      selectAgentTabSidebarLabel({ session: cached, context, workspaceTitleSource: "title" }),
    ).toBe(workspace.name);
    expect(
      selectAgentTabSidebarLabel({ session: cached, context, workspaceTitleSource: "branch" }),
    ).toBe("feat/payments");
    expect(
      selectAgentTabSidebarLabel({
        session: session(" HEAD "),
        context,
        workspaceTitleSource: "branch",
      }),
    ).toBe(workspace.name);
    expect(
      selectAgentTabSidebarLabel({ session: session(), context, workspaceTitleSource: "branch" }),
    ).toBe(workspace.name);
    expect(cached.workspaces.get(workspace.id)?.name).toBe(workspace.name);
  });

  it("uses the validated owning parent for provider subagent tabs", () => {
    const cached = session();
    const subagentContext = { ...context, subagentId: "provider-subagent-a" };
    expect(
      selectAgentTabSidebarLabel({
        session: cached,
        context: subagentContext,
        workspaceTitleSource: "title",
      }),
    ).toBe(workspace.name);
    cached.agents.set("agent-a", { workspaceId: "different-workspace" });
    expect(
      selectAgentTabSidebarLabel({
        session: cached,
        context: subagentContext,
        workspaceTitleSource: "title",
      }),
    ).toBeNull();
  });

  it("falls back while loading and refuses a different workspace at the same path", () => {
    expect(
      selectAgentTabSidebarLabel({ session: undefined, context, workspaceTitleSource: "title" }),
    ).toBeNull();
    const cached = session();
    cached.agents.set("agent-a", { workspaceId: "other-workspace" });
    cached.workspaces.set("other-workspace", {
      ...workspace,
      id: "other-workspace",
      name: "Other",
    });
    expect(
      selectAgentTabSidebarLabel({ session: cached, context, workspaceTitleSource: "title" }),
    ).toBeNull();
    cached.agents.set("agent-a", { workspaceId: "workspace-a" });
    cached.workspaces.delete("workspace-a");
    expect(
      selectAgentTabSidebarLabel({ session: cached, context, workspaceTitleSource: "title" }),
    ).toBeNull();
  });
});
