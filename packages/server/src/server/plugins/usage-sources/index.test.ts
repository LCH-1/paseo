import { expect, test, vi } from "vitest";
import { UsageSourceRegistry } from "./index.js";

test("compatibility sources share one fetch and freshness while retaining their report identities", async () => {
  let calls = 0;
  const registry = new UsageSourceRegistry();
  const fetch = async () => {
    calls++;
    return { status: "available", windows: [] };
  };
  const discover = async () => [{ key: "same-account", input: { store: "fixture" } }];
  for (const id of ["claude", "claude-windows"])
    registry.register({
      id,
      cacheGroup: "owned-generation:claude",
      label: "Claude",
      discover,
      fetch,
    });
  const first = await registry.listReports();
  expect(calls).toBe(1);
  expect(first.map(({ id }) => id).sort()).toEqual([
    "claude-windows:same-account",
    "claude:same-account",
  ]);
  expect(first.map(({ sourceId }) => sourceId).sort()).toEqual(["claude", "claude-windows"]);
  await registry.listReports();
  expect(calls).toBe(1);
  await registry.listReports({ forceRefresh: true });
  expect(calls).toBe(2);
  registry.unregister("claude-windows");
  expect((await registry.listReports()).map(({ sourceId }) => sourceId)).toEqual(["claude"]);
  expect(calls).toBe(2);
  registry.unregister("claude");
  registry.register({
    id: "claude",
    cacheGroup: "replacement-generation:claude",
    label: "Claude",
    discover,
    fetch,
  });
  await registry.listReports();
  expect(calls).toBe(3);
});
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSession as discoverCursorSession,
  fetchUsage as fetchCursorUsage,
} from "../../../../../../plugins/cursor-usage-source/server/usage.js";
import { inputSchema as cursorInputSchema } from "../../../../../../plugins/cursor-usage-source/shared/input.js";

test("#7142: host usage retains distinct Cursor accounts after their individual details are read", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-accounts-"));
  try {
    const sessions = new Map<
      string,
      { provider: string; sessionKey: string; env: Record<string, string> }
    >();
    const spends = new Map<string, number>();
    for (const [agentId, account, spend] of [
      ["a", "user-a", 100],
      ["b", "user-b", 200],
      ["a-copy", "user-a", 100],
    ] as const) {
      const configHome = join(root, agentId);
      const token = `e30.${Buffer.from(JSON.stringify({ sub: account, nonce: agentId })).toString("base64url")}.signature`;
      await mkdir(join(configHome, "cursor"), { recursive: true });
      await writeFile(
        join(configHome, "cursor", "auth.json"),
        JSON.stringify({ accessToken: token }),
      );
      spends.set(`Bearer ${token}`, spend);
      sessions.set(agentId, {
        provider: "cursor",
        sessionKey: agentId,
        env: { XDG_CONFIG_HOME: configHome },
      });
    }
    const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
      hasAgent: (id) => sessions.has(id),
      usageSession: (id) => sessions.get(id) ?? null,
    });
    const fetchApi: typeof fetch = async (_url, init) => {
      const authorization = new Headers(init?.headers).get("Authorization") ?? "";
      const spend = spends.get(authorization);
      if (spend === undefined) throw new Error("Unexpected fixture login");
      return new Response(JSON.stringify({ planUsage: { totalSpend: spend, limit: 1000 } }));
    };
    registry.register({
      id: "cursor",
      label: "Cursor",
      discover: (scope) =>
        scope.kind === "session" ? discoverCursorSession(scope, "linux") : Promise.resolve([]),
      fetch: (input) => fetchCursorUsage(cursorInputSchema.parse(input), fetchApi),
    });
    const spent = (reports: Awaited<ReturnType<typeof registry.listReports>>) =>
      reports.map((entry) => {
        if (entry.report.status !== "available")
          throw new Error("Expected available fixture usage");
        return entry.report.balances?.[0]?.used;
      });
    expect(spent(await registry.listReports({ agentId: "a" }))).toEqual([1]);
    expect(spent(await registry.listReports({ agentId: "b" }))).toEqual([2]);
    expect(spent(await registry.listReports({ agentId: "a-copy" }))).toEqual([1]);
    expect(spent(await registry.listReports())).toEqual([1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function source(input: {
  id: string;
  discover?: () => Promise<Array<{ key: string; label?: string; input: unknown }>>;
  fetch?: (value: unknown) => Promise<unknown>;
}) {
  return {
    id: input.id,
    label: input.id,
    discover: input.discover ?? (async () => []),
    fetch: input.fetch ?? (async () => ({ status: "available", windows: [] })),
  };
}

test("discovery preserves account IDs and updates input after token rotation", async () => {
  const registry = new UsageSourceRegistry();
  let token = "old";
  registry.register(
    source({
      id: "codex",
      discover: async () => [{ key: "work", input: { token } }],
      fetch: async (input) => ({
        status: "available",
        windows: [{ id: "token", label: (input as { token: string }).token }],
      }),
    }),
  );
  const first = await registry.listReports();
  expect(first.map((entry) => entry.id)).toEqual(["codex:work"]);
  expect(first[0]?.report.windows[0]?.label).toBe("old");
  token = "new";
  const refreshed = await registry.listReports({ forceRefresh: true });
  expect(refreshed.map((entry) => entry.id)).toEqual(["codex:work"]);
  expect(refreshed[0]?.report.windows[0]?.label).toBe("new");
});

test("coalesces per account, caches errors, and refreshes only requested IDs", async () => {
  let now = 0;
  const counts = new Map<string, number>();
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => ["a", "b"].map((account) => ({ key: account, input: { account } })),
      fetch: async (input) => {
        const account = (input as { account: string }).account;
        counts.set(account, (counts.get(account) ?? 0) + 1);
        if (account === "b") throw new Error("failed");
        return { status: "available", windows: [] };
      },
    }),
  );
  const first = await registry.listReports();
  expect(first.map((entry) => entry.id)).toEqual(["source:a", "source:b"]);
  expect(first[1]?.report.status).toBe("error");
  expect(await registry.listReports()).toEqual(first);
  expect(counts.get("a")).toBe(1);
  expect(counts.get("b")).toBe(1);
  now = 1000;
  const refreshed = await registry.listReports({
    reportIds: ["source:a", "missing:id"],
    forceRefresh: true,
  });
  expect(refreshed.map((entry) => entry.id)).toEqual(["source:a"]);
  expect(refreshed[0]?.fetchedAt).not.toBe(first[0]?.fetchedAt);
  expect(counts.get("a")).toBe(2);
  expect(counts.get("b")).toBe(1);
  now = 301_001;
  await registry.listReports({ reportIds: ["source:a"] });
  expect(counts.get("a")).toBe(3);
});

test("legacy listing uses oldest fetchedAt", async () => {
  let now = 1000;
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => ["a", "b"].map((account) => ({ key: account, input: { account } })),
    }),
  );
  await registry.listReports();
  now = 2000;
  await registry.listReports({ reportIds: ["source:b"], forceRefresh: true });
  expect((await registry.listLegacyUsage()).fetchedAt).toBe(new Date(1000).toISOString());
});

test("concurrent requests for the same ID share one vendor fetch", async () => {
  let finish!: (report: unknown) => void;
  const response = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  let fetches = 0;
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "coalesced",
      discover: async () => [{ key: "one", input: {} }],
      fetch: async () => {
        fetches++;
        return response;
      },
    }),
  );
  const first = registry.listReports();
  const second = registry.listReports();
  finish({ status: "available", windows: [] });
  const [one, two] = await Promise.all([first, second]);
  expect(one[0]).toBe(two[0]);
  expect(fetches).toBe(1);
});

test("rediscovery removes an old account from targeted refreshes", async () => {
  let now = 0;
  const registry = new UsageSourceRegistry(() => now, 100);
  let account = "old";
  registry.register(source({ id: "source", discover: async () => [{ key: account, input: {} }] }));
  await registry.listReports();
  await registry.listReports({ reportIds: ["source:old"] });
  now = 101;
  account = "new";
  await registry.listReports();
  await registry.listReports({ reportIds: ["source:new"] });
  expect(await registry.listReports({ reportIds: ["source:old"] })).toEqual([]);
});

test("discovery failures log once while other sources still report", async () => {
  const warnings: unknown[][] = [];
  const registry = new UsageSourceRegistry(Date.now, 300_000, {
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  });
  const err = new Error("subprocess stopped");
  registry.register(
    source({
      id: "kimi",
      discover: async () => {
        throw err;
      },
    }),
  );
  registry.register(source({ id: "healthy", discover: async () => [{ key: "one", input: {} }] }));
  const updates: string[] = [];
  const reports = await registry.listReports({ onReport: (report) => updates.push(report.id) });
  expect(reports.map((report) => report.id)).toEqual(["healthy:one"]);
  expect(updates).toEqual(["healthy:one"]);
  expect(warnings).toEqual([[{ sourceId: "kimi", err }, "Usage source discovery failed"]]);
});

test("a failed fetch is logged as well as reported", async () => {
  const warnings: unknown[][] = [];
  const registry = new UsageSourceRegistry(Date.now, 300_000, {
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  });
  const err = new Error("Rate limited by Claude. Try again in 38m.");
  registry.register(
    source({
      id: "claude",
      discover: async () => [{ key: "work", input: {} }],
      fetch: async () => {
        throw err;
      },
    }),
  );
  const [report] = await registry.listReports();
  expect(report?.report).toEqual({ status: "error", error: err.message });
  expect(warnings).toEqual([[{ sourceId: "claude", err }, "Usage fetch failed"]]);
});

test("legacy listing distinguishes labeled accounts and preserves unlabeled names", async () => {
  const registry = new UsageSourceRegistry(() => 1000);
  registry.register(
    source({
      id: "claude",
      discover: async () =>
        ["work", "personal", "default"].map((key) => ({
          key,
          label: key === "default" ? undefined : key,
          input: {},
        })),
    }),
  );
  expect(
    (await registry.listLegacyUsage()).providers.map((provider) => provider.displayName),
  ).toEqual(["claude (work)", "claude (personal)", "claude"]);
});

test("duplicate logins prefer discovery order across unavailable, error and thrown fetches", async () => {
  for (const failure of ["unavailable", "error", "throw"]) {
    const registry = new UsageSourceRegistry();
    const calls: number[] = [];
    registry.register(
      source({
        id: "codex",
        discover: async () => [0, 1, 2].map((input) => ({ key: "same", input })),
        fetch: async (input) => {
          calls.push(Number(input));
          if (input === 0) {
            if (failure === "throw") throw new Error("revoked");
            return failure === "unavailable"
              ? { status: failure, problem: { kind: "rejected", status: 401 } }
              : { status: failure, error: "revoked" };
          }
          return {
            status: "available",
            windows: [{ id: "session", label: "Session", usedPct: 42 }],
          };
        },
      }),
    );
    const reports = await registry.listReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.report.status).toBe("available");
    expect(calls).toEqual([0, 1, 2]);
  }
});

test("targeted refresh re-reads the login without discovering again", async () => {
  let discoveries = 0;
  let value = "old";
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => {
        discoveries++;
        return [{ key: "original", input: {} }];
      },
      fetch: async () => ({ status: "available", windows: [{ id: "session", label: value }] }),
    }),
  );
  await registry.listReports();
  value = "new";
  const reports = await registry.listReports({
    reportIds: ["source:original"],
    forceRefresh: true,
  });
  expect(reports[0]?.report).toEqual({
    status: "available",
    windows: [{ id: "session", label: "new" }],
  });
  expect(discoveries).toBe(1);
});

test("a thrown fetch is an error card", async () => {
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => [{ key: "one", input: {} }],
      fetch: async () => {
        throw new Error("Store deleted");
      },
    }),
  );
  expect((await registry.listReports())[0]?.report).toEqual({
    status: "error",
    error: "Store deleted",
  });
});

test("an unavailable login falls back to the next available login", async () => {
  const calls: unknown[] = [];
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => [1, 2].map((input) => ({ key: "same", input })),
      fetch: async (input) => {
        calls.push(input);
        return input === 1
          ? {
              status: "unavailable",
              problem: { kind: "expired", expiresAt: "1970-01-01T00:00:00.000Z" },
            }
          : { status: "available", windows: [] };
      },
    }),
  );
  expect(
    (await registry.listReports()).map((entry) => ({ id: entry.id, report: entry.report })),
  ).toEqual([{ id: "source:same", report: { status: "available", windows: [] } }]);
  expect(calls).toEqual([1, 2]);
});

test("failed fallbacks preserve the final problem", async () => {
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => [1, 2].map((input) => ({ key: "same", input })),
      fetch: async (input) => ({
        status: "unavailable",
        problem: { kind: "rejected", status: input === 1 ? 401 : 403 },
      }),
    }),
  );
  expect((await registry.listReports())[0]?.report).toEqual({
    status: "unavailable",
    problem: { kind: "rejected", status: 403 },
  });
});

test("session discovery reuses accounts, separates launches, and retains live agent reports globally", async () => {
  const sessions = new Map([
    ["one", { provider: "claude", env: { HOME: "/one" }, sessionKey: "launch-1" }],
    ["two", { provider: "claude", env: { HOME: "/two" }, sessionKey: "launch-2" }],
  ]);
  const existing = new Set(["one", "two", "closed"]);
  const discoveries: string[] = [];
  let fetches = 0;
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => existing.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  registry.register({
    id: "claude",
    label: "Claude",
    discover: async (scope) => {
      discoveries.push(scope.kind === "global" ? "global" : scope.env.HOME);
      if (scope.kind === "global") return [{ key: "default", input: "default" }];
      return [{ key: scope.env.HOME === "/new" ? "new" : "same", input: scope.env.HOME }];
    },
    fetch: async () => {
      fetches++;
      return { status: "available", windows: [] };
    },
  });
  expect(await registry.listReports({ agentId: "closed" })).toEqual([]);
  expect((await registry.listReports({ agentId: "one" })).map((r) => r.id)).toEqual([
    "claude:same",
  ]);
  await registry.listReports({ agentId: "one" });
  await registry.listReports({ agentId: "two" });
  expect(discoveries).toEqual(["/one", "/two"]);
  expect(fetches).toBe(2);
  expect((await registry.listReports()).map((r) => r.id)).toEqual([
    "claude:default",
    "claude:same",
  ]);
  sessions.set("one", { provider: "claude", env: { HOME: "/new" }, sessionKey: "launch-3" });
  expect((await registry.listReports({ agentId: "one" })).map((r) => r.id)).toEqual(["claude:new"]);
  existing.delete("two");
  sessions.delete("two");
  expect((await registry.listReports()).map((r) => r.id)).toEqual(["claude:default", "claude:new"]);
  await expect(registry.listReports({ agentId: "missing" })).rejects.toThrow("Unknown agent");
  await expect(registry.listReports({ agentId: "one", reportIds: [] })).rejects.toThrow("agentId");
});

test("reports arrive independently and a hung fetch settles as an error before completion", async () => {
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, undefined, 25);
  let finishSlow!: (value: unknown) => void;
  const slow = new Promise<unknown>((resolve) => {
    finishSlow = resolve;
  });
  const reports: string[] = [];
  let firstReport!: () => void;
  const first = new Promise<void>((resolve) => {
    firstReport = resolve;
  });
  for (const id of ["slow", "fast", "also-fast"]) {
    registry.register(
      source({
        id,
        discover: async () => [{ key: "account", input: {} }],
        fetch: async () => (id === "slow" ? slow : { status: "available", windows: [] }),
      }),
    );
  }
  let complete = false;
  const request = registry
    .listReports({
      onReport: (entry) => {
        reports.push(entry.id);
        firstReport();
      },
    })
    .then((entries) => {
      complete = true;
      return entries;
    });
  await first;
  expect(reports).toEqual(["fast:account", "also-fast:account"]);
  expect(complete).toBe(false);
  const entries = await request;
  expect(reports).toEqual(["fast:account", "also-fast:account", "slow:account"]);
  expect(entries[0]?.report).toEqual({ status: "error", error: "Usage fetch timed out" });
  finishSlow({ status: "available", windows: [] });
  expect((await registry.listReports({ reportIds: ["slow:account"] }))[0]?.report).toEqual(
    entries[0]?.report,
  );
});

test("#6155: agent reports use only their session login despite host and sibling discoveries", async () => {
  const sessions = new Map([
    ["codex-agent", { provider: "codex", env: {}, sessionKey: "codex-launch" }],
    ["opencode-agent", { provider: "opencode", env: {}, sessionKey: "opencode-launch" }],
  ]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  const codexError = { status: "error", error: "Codex usage API returned 500" };
  const expired = {
    status: "unavailable",
    problem: { kind: "expired", expiresAt: "2026-07-07T00:00:00.000Z", refreshedBy: "opencode" },
  };
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async (scope) =>
      (scope.kind === "global" ? ["codex", "opencode"] : [scope.provider]).map((harness) => ({
        key: "same",
        harness,
        input: { harness },
      })),
    fetch: async (input) =>
      (input as { harness: string }).harness === "codex" ? codexError : expired,
  });
  await registry.listReports();
  await registry.listReports({ agentId: "opencode-agent" });
  expect((await registry.listReports({ agentId: "codex-agent" }))[0]?.report).toEqual(codexError);
});

test("all failed host logins retain each source-supplied harness and remedy", async () => {
  const registry = new UsageSourceRegistry();
  const failures = [
    { status: "error", error: "Codex usage API returned 500" },
    {
      status: "unavailable",
      problem: { kind: "expired", expiresAt: "2026-07-07T00:00:00.000Z", refreshedBy: "opencode" },
    },
    { status: "unavailable", problem: { kind: "rejected", status: 401, refreshedBy: "pi" } },
    { status: "unavailable", problem: { kind: "rejected", status: 403, refreshedBy: "omp" } },
  ];
  const harnesses = ["Codex", "OpenCode", "Pi", "OMP"];
  registry.register(
    source({
      id: "codex",
      discover: async () => harnesses.map((harness, input) => ({ key: "same", harness, input })),
      fetch: async (input) => failures[Number(input)],
    }),
  );
  const [entry] = await registry.listReports();
  expect(entry?.loginErrors).toEqual(
    harnesses.map((harness, index) => ({ harness, report: failures[index] })),
  );
});

test("a working agent login never uses another harness's failure or host fallback cache", async () => {
  const sessions = new Map([
    ["working", { provider: "codex", env: {}, sessionKey: "one" }],
    ["broken", { provider: "opencode", env: {}, sessionKey: "two" }],
  ]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  const available = {
    status: "available",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 31 }],
  };
  const error = { status: "error", error: "OpenCode login rejected. Run opencode to refresh it." };
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async (scope) =>
      (scope.kind === "global" ? ["opencode", "codex"] : [scope.provider]).map((harness) => ({
        key: "same",
        harness,
        input: harness,
      })),
    fetch: async (input) => (input === "codex" ? available : error),
  });
  const [host] = await registry.listReports();
  expect(host?.report).toEqual(available);
  expect(host?.loginErrors).toBeUndefined();
  expect((await registry.listReports({ agentId: "working" }))[0]?.report).toEqual(available);
  expect((await registry.listReports({ agentId: "broken" }))[0]?.report).toEqual(error);
  expect(
    (await registry.listReports({ agentId: "broken", forceRefresh: true }))[0]?.report,
  ).toEqual(error);
  expect(
    (await registry.listReports({ reportIds: ["codex:same"], forceRefresh: true }))[0]?.report,
  ).toEqual(available);
});

test("concurrent host and agent requests never share a different login's pending fetch", async () => {
  let finish!: (report: unknown) => void;
  const slow = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => true,
    usageSession: () => ({ provider: "codex", env: {}, sessionKey: "launch" }),
  });
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async (scope) => [{ key: "same", harness: "Codex", input: scope.kind }],
    fetch: async (input) =>
      input === "global" ? slow : { status: "error", error: "Session login failed" },
  });
  const host = registry.listReports();
  const [agent] = await registry.listReports({ agentId: "agent" });
  expect(agent?.report).toEqual({ status: "error", error: "Session login failed" });
  finish({ status: "available", windows: [] });
  expect((await host)[0]?.report.status).toBe("available");
});

test("duplicate logins across scopes appear only once in the host's errors", async () => {
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => true,
    usageSession: () => ({ provider: "codex", env: {}, sessionKey: "launch" }),
  });
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async (scope) => [
      {
        key: "same",
        harness: "Codex",
        input:
          scope.kind === "global"
            ? { path: "/auth", kind: "file" }
            : { kind: "file", path: "/auth" },
      },
    ],
    fetch: async () => ({ status: "error", error: "Login failed" }),
  });
  await registry.listReports({ agentId: "agent" });
  expect((await registry.listReports())[0]?.loginErrors).toEqual([
    { harness: "Codex", report: { status: "error", error: "Login failed" } },
  ]);
});

test("a hung login records its own timeout and still tries the next login", async () => {
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, undefined, 25);
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async () => [
      { key: "same", harness: "Codex", input: 0 },
      { key: "same", harness: "OpenCode", input: 1 },
    ],
    fetch: async (input) =>
      input === 0 ? new Promise(() => {}) : { status: "error", error: "Login rejected" },
  });
  expect((await registry.listReports())[0]?.loginErrors).toEqual([
    { harness: "Codex", report: { status: "error", error: "Usage fetch timed out" } },
    { harness: "OpenCode", report: { status: "error", error: "Login rejected" } },
  ]);
});

test("retains the last successful poll across failures, cache expiry, and recovery", async () => {
  let now = 0;
  let report: unknown = {
    status: "available",
    windows: [{ id: "week", label: "Weekly", usedPct: 42 }],
  };
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "quota",
      discover: async () => [{ key: "account", input: {} }],
      fetch: async () => report,
    }),
  );
  registry.register(source({ id: "other", discover: async () => [{ key: "account", input: {} }] }));
  const [success] = await registry.listReports();
  now = 360_000;
  // An unrelated write evicts the expired fetch result, but must not discard its snapshot.
  await registry.listReports({ reportIds: ["other:account"], forceRefresh: true });
  report = { status: "error", error: "Rate limited" };
  const [failure] = await registry.listReports({ reportIds: ["quota:account"] });
  expect(failure).toMatchObject({
    fetchedAt: new Date(now).toISOString(),
    report,
    lastSuccessful: { fetchedAt: success!.fetchedAt, report: success!.report },
  });
  now += 360_000;
  const [repeated] = await registry.listReports({ reportIds: ["quota:account"] });
  expect(repeated?.lastSuccessful).toEqual(failure?.lastSuccessful);
  report = { status: "unavailable", problem: { kind: "no_quota", detail: "No quota" } };
  const [unavailable] = await registry.listReports({
    reportIds: ["quota:account"],
    forceRefresh: true,
  });
  expect(unavailable?.lastSuccessful).toEqual(failure?.lastSuccessful);
  now += 1000;
  report = { status: "available", windows: [{ id: "week", label: "Weekly", usedPct: 43 }] };
  const [recovered] = await registry.listReports({
    reportIds: ["quota:account"],
    forceRefresh: true,
  });
  expect(recovered?.report).toEqual(report);
  expect(recovered?.lastSuccessful).toBeUndefined();
  expect(recovered?.fetchedAt).toBe(new Date(now).toISOString());
});

test("successful history is isolated by login set and pruned when identities retire", async () => {
  let login = "old";
  let present = true;
  let available = true;
  const registry = new UsageSourceRegistry();
  const fixture = source({
    id: "source",
    discover: async () => (present ? [{ key: "same", input: login }] : []),
    fetch: async () =>
      available ? { status: "available", windows: [] } : { status: "error", error: "failed" },
  });
  registry.register(fixture);
  await registry.listReports();
  available = false;
  login = "new";
  expect((await registry.listReports({ forceRefresh: true }))[0]?.lastSuccessful).toBeUndefined();
  login = "old";
  expect((await registry.listReports({ forceRefresh: true }))[0]?.lastSuccessful).toBeUndefined();
  available = true;
  await registry.listReports({ forceRefresh: true });
  present = false;
  expect(await registry.listReports({ forceRefresh: true })).toEqual([]);
  present = true;
  available = false;
  const [returned] = await registry.listReports({ forceRefresh: true });
  expect(returned?.report.status).toBe("error");
  expect(returned?.lastSuccessful).toBeUndefined();
  available = true;
  await registry.listReports({ forceRefresh: true });
  registry.unregister("source");
  registry.register(fixture);
  available = false;
  expect((await registry.listReports())[0]?.lastSuccessful).toBeUndefined();
});

test("host fallback history never supplies an agent's failed login, and removed agents lose history", async () => {
  const sessions = new Map([["agent", { provider: "codex", env: {}, sessionKey: "one" }]]);
  let available = true;
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  registry.register({
    id: "source",
    label: "Source",
    discover: async (scope) =>
      (scope.kind === "global" ? ["host", "agent"] : ["agent"]).map((input) => ({
        key: "same",
        input,
      })),
    fetch: async () =>
      available ? { status: "available", windows: [] } : { status: "error", error: "failed" },
  });
  await registry.listReports();
  available = false;
  expect((await registry.listReports({ agentId: "agent" }))[0]?.lastSuccessful).toBeUndefined();
  available = true;
  const [success] = await registry.listReports({ agentId: "agent", forceRefresh: true });
  available = false;
  expect(
    (await registry.listReports({ agentId: "agent", forceRefresh: true }))[0]?.lastSuccessful
      ?.report,
  ).toEqual(success?.report);
  sessions.delete("agent");
  await registry.listReports();
  sessions.set("agent", { provider: "codex", env: {}, sessionKey: "two" });
  expect((await registry.listReports({ agentId: "agent" }))[0]?.lastSuccessful).toBeUndefined();
});

test("a timed out poll retains successful values and late completion cannot replace the failure", async () => {
  let now = 1000;
  let finish!: (value: unknown) => void;
  let slow = false;
  const registry = new UsageSourceRegistry(() => now, 300_000, undefined, undefined, 10);
  registry.register(
    source({
      id: "source",
      discover: async () => [{ key: "same", input: {} }],
      fetch: async () =>
        slow
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : { status: "available", windows: [] },
    }),
  );
  const [success] = await registry.listReports();
  now = 2000;
  slow = true;
  const [failure] = await registry.listReports({ forceRefresh: true });
  expect(failure?.report).toEqual({ status: "error", error: "Usage fetch timed out" });
  expect(failure?.lastSuccessful).toEqual({
    fetchedAt: success?.fetchedAt,
    report: success?.report,
  });
  finish({ status: "available", windows: [{ id: "late", label: "Late" }] });
  expect((await registry.listReports())[0]).toEqual(failure);
});

test("attempt ordering keeps its timestamp while retained freshness records successful completion", async () => {
  let now = 1000;
  let available = true;
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => [{ key: "same", input: {} }],
      fetch: async () => {
        if (available) now = 2000;
        return available
          ? { status: "available", windows: [] }
          : { status: "error", error: "failed" };
      },
    }),
  );
  const [success] = await registry.listReports();
  expect(success?.fetchedAt).toBe(new Date(1000).toISOString());
  expect(success?.successfulAt).toBe(new Date(2000).toISOString());
  available = false;
  now = 3000;
  const [failure] = await registry.listReports({ forceRefresh: true });
  expect(failure?.fetchedAt).toBe(new Date(3000).toISOString());
  expect(failure?.lastSuccessful?.fetchedAt).toBe(success?.successfulAt);
});

test("failed discovery preserves history until discovery confirms account removal", async () => {
  let discoveryFails = false;
  let present = true;
  let available = true;
  const registry = new UsageSourceRegistry(() => 1000, 300_000, { warn: () => {} });
  registry.register(
    source({
      id: "source",
      discover: async () => {
        if (discoveryFails) throw new Error("Login store temporarily unavailable");
        return present ? [{ key: "account", input: {} }] : [];
      },
      fetch: async () =>
        available
          ? { status: "available", windows: [{ id: "weekly", label: "Weekly", usedPct: 42 }] }
          : { status: "error", error: "Rate limited" },
    }),
  );
  const [success] = await registry.listReports();
  available = false;
  discoveryFails = true;
  const [duringDiscoveryFailure] = await registry.listReports({ forceRefresh: true });
  expect(duringDiscoveryFailure?.lastSuccessful).toEqual({
    fetchedAt: success?.successfulAt,
    report: success?.report,
  });
  discoveryFails = false;
  const [afterDiscoveryRecovery] = await registry.listReports({ forceRefresh: true });
  expect(afterDiscoveryRecovery?.lastSuccessful).toEqual(duringDiscoveryFailure?.lastSuccessful);
  expect(afterDiscoveryRecovery?.report).toEqual({ status: "error", error: "Rate limited" });
  present = false;
  expect(await registry.listReports({ forceRefresh: true })).toEqual([]);
  present = true;
  const [returned] = await registry.listReports({ forceRefresh: true });
  expect(returned?.report).toEqual({ status: "error", error: "Rate limited" });
  expect(returned?.lastSuccessful).toBeUndefined();
});

test("concurrent host queries share one discovery and one fetch per account", async () => {
  let finishDiscovery!: (accounts: Array<{ key: string; input: unknown }>) => void;
  const discovery = new Promise<Array<{ key: string; input: unknown }>>((resolve) => {
    finishDiscovery = resolve;
  });
  let discoveries = 0;
  let fetches = 0;
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => {
        discoveries++;
        return discovery;
      },
      fetch: async () => {
        fetches++;
        return { status: "available", windows: [] };
      },
    }),
  );
  const streamed: string[][] = [[], [], [], [], []];
  const queries = streamed.map((updates) =>
    registry.listReports({ onReport: (report) => updates.push(report.id) }),
  );
  finishDiscovery([{ key: "one", input: {} }]);
  const listed = (await Promise.all(queries)).map((reports) => reports.map((report) => report.id));
  const oneReportEach = [
    ["source:one"],
    ["source:one"],
    ["source:one"],
    ["source:one"],
    ["source:one"],
  ];
  expect(listed).toEqual(oneReportEach);
  expect(streamed).toEqual(oneReportEach);
  expect(discoveries).toBe(1);
  expect(fetches).toBe(1);
});

/** Lets work a query started behind its answer finish. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Resolves after a timer, so fake timers can time a source call. */
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("host discovery is reused while its reports are cached and renewed before they are fetched again", async () => {
  let now = 0;
  let login = "first";
  const events: string[] = [];
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => {
        events.push(`discover:${login}`);
        return [{ key: "account", input: login }];
      },
      fetch: async (input) => {
        events.push(`fetch:${String(input)}`);
        return { status: "available", windows: [] };
      },
    }),
  );
  await registry.listReports();
  login = "second";
  now = 66_000;
  await registry.listReports();
  now = 239_999;
  await registry.listReports();
  expect(events).toEqual(["discover:first", "fetch:first"]);
  // The last minute of the window renews it, reading the store before fetching with its login.
  now = 240_000;
  await registry.listReports();
  await settle();
  expect(events).toEqual(["discover:first", "fetch:first", "discover:second", "fetch:second"]);
  now = 300_000;
  await registry.listReports();
  expect(events).toHaveLength(4);
  // A window that ends without a query is renewed before the next query is answered.
  login = "third";
  now = 1_000_000;
  await registry.listReports();
  expect(events.slice(4)).toEqual(["discover:third", "fetch:third"]);
});

test("a query near the end of the cache window is answered from the cache while the window is renewed", async () => {
  let now = 0;
  let value = "old";
  let discoveries = 0;
  let releaseStore = () => {};
  let releaseVendor = () => {};
  const store = new Promise<void>((resolve) => {
    releaseStore = resolve;
  });
  const vendor = new Promise<void>((resolve) => {
    releaseVendor = resolve;
  });
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => {
        discoveries++;
        if (discoveries > 1) await store;
        return [{ key: "account", input: {} }];
      },
      fetch: async () => {
        const label = value;
        if (label === "new") await vendor;
        return { status: "available", windows: [{ id: "window", label }] };
      },
    }),
  );
  const [first] = await registry.listReports();
  value = "new";
  now = 250_000;
  const answers: string[] = [];
  const answered = await registry.listReports({ onReport: (entry) => answers.push(entry.id) });
  // Neither the login store nor the vendor has answered yet, and the query waited for neither.
  expect(answered).toEqual([first]);
  expect(answers).toEqual(["source:account"]);
  expect(discoveries).toBe(2);
  // Queries while the renewal runs neither wait nor start another one.
  now = 260_000;
  expect(await registry.listReports()).toEqual([first]);
  releaseStore();
  await settle();
  expect(await registry.listReports()).toEqual([first]);
  expect(discoveries).toBe(2);
  releaseVendor();
  await settle();
  const [renewed] = await registry.listReports();
  expect(renewed?.report).toEqual({
    status: "available",
    windows: [{ id: "window", label: "new" }],
  });
  // Fetched once the store had answered, with the login it named.
  expect(renewed?.fetchedAt).toBe(new Date(260_000).toISOString());
});

test("a report older than the cache window is never answered; the query waits for a new fetch", async () => {
  let now = 0;
  let value = "old";
  let release = () => {};
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => [{ key: "account", input: {} }],
      fetch: async () => {
        const label = value;
        if (label === "new")
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return { status: "available", windows: [{ id: "window", label }] };
      },
    }),
  );
  await registry.listReports();
  value = "new";
  now = 300_000;
  let answered = false;
  const query = registry.listReports().then((reports) => {
    answered = true;
    return reports;
  });
  await settle();
  expect(answered).toBe(false);
  release();
  const [renewed] = await query;
  expect(renewed?.fetchedAt).toBe(new Date(300_000).toISOString());
  expect(renewed?.report).toEqual({
    status: "available",
    windows: [{ id: "window", label: "new" }],
  });
});

test.each([1, 4])(
  "%i app windows polling every minute never wait and cost one discovery per five minutes, even after a report was refreshed alone",
  async (windows) => {
    let now = 0;
    let discoveries = 0;
    const fetched: string[] = [];
    const registry = new UsageSourceRegistry(() => now);
    registry.register(
      source({
        id: "source",
        // Each takes its time after the query that started it has had its chance to answer.
        discover: async () => {
          discoveries++;
          await settle();
          now += 1_000;
          return ["a", "b"].map((key) => ({ key, input: key }));
        },
        fetch: async (input) => {
          fetched.push(String(input));
          await settle();
          now += 500;
          return { status: "available", windows: [] };
        },
      }),
    );
    await registry.listReports();
    // A targeted refresh puts one account a minute behind the other.
    now = 60_000;
    await registry.listReports({ reportIds: ["source:b"], forceRefresh: true });
    discoveries = 0;
    fetched.length = 0;
    const waits: number[] = [];
    // The windows poll a quarter of a minute apart, each once a minute, for an hour.
    for (let tick = 8; tick < 8 + 4 * 60; tick++) {
      if (tick % 4 >= windows) continue;
      now = Math.max(now, tick * 15_000);
      const asked = now;
      await registry.listReports();
      waits.push(now - asked);
      for (let step = 0; step < 4; step++) await settle();
    }
    expect(waits.filter((wait) => wait > 0)).toEqual([]);
    // Each discovery renews both accounts; none is spent on one whose window ended alone.
    expect(fetched).toHaveLength(2 * discoveries);
    // Renewing a minute early would take 15 discoveries in the hour instead of 12.
    expect(discoveries).toBeLessThanOrEqual(12);
  },
);

test("a forced refresh during a background renewal waits for a discovery started after it", async () => {
  let now = 0;
  const store = ["a"];
  const answers: Array<() => void> = [];
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: () => {
        // The login store is read when the discovery starts, not when it answers.
        const accounts = store.map((key) => ({ key, input: key }));
        return new Promise((resolve) => {
          answers.push(() => resolve(accounts));
        });
      },
    }),
  );
  const first = registry.listReports();
  answers[0]!();
  await first;
  now = 250_000;
  expect((await registry.listReports()).map((report) => report.id)).toEqual(["source:a"]);
  expect(answers).toHaveLength(2);
  store.push("b");
  const forced = registry.listReports({ forceRefresh: true });
  answers[1]!();
  await vi.waitFor(() => expect(answers).toHaveLength(3));
  answers[2]!();
  expect((await forced).map((report) => report.id)).toEqual(["source:a", "source:b"]);
});

test("a poll made while a forced refresh rediscovers the host waits for it instead of answering with the logins it replaces", async () => {
  let now = 0;
  let store = "a";
  const answers: Array<() => void> = [];
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: () => {
        // The login store is read when the discovery starts, not when it answers.
        const accounts = [{ key: store, input: store }];
        return new Promise((resolve) => {
          answers.push(() => resolve(accounts));
        });
      },
    }),
  );
  const ids = async (query: ReturnType<typeof registry.listReports>) =>
    (await query).map((report) => report.id);
  const first = registry.listReports();
  answers[0]!();
  expect(await ids(first)).toEqual(["source:a"]);
  // Another login is signed in and refreshed for, while another window polls inside the window.
  now = 100_000;
  store = "b";
  const forced = registry.listReports({ forceRefresh: true });
  const polled = registry.listReports();
  answers[1]!();
  expect(await ids(polled)).toEqual(["source:b"]);
  expect(await ids(forced)).toEqual(["source:b"]);
  expect(answers).toHaveLength(2);
  // Likewise for a forced refresh queued behind a renewal that runs behind the cache's answers.
  now = 350_000;
  expect(await ids(registry.listReports())).toEqual(["source:b"]);
  expect(answers).toHaveLength(3);
  store = "c";
  const forcedAgain = registry.listReports({ forceRefresh: true });
  const polledAgain = registry.listReports();
  answers[2]!();
  await vi.waitFor(() => expect(answers).toHaveLength(4));
  answers[3]!();
  expect(await ids(polledAgain)).toEqual(["source:c"]);
  expect(await ids(forcedAgain)).toEqual(["source:c"]);
});

test("an agent running under a login the host lists adds no vendor fetch to its group's renewals", async () => {
  let now = 0;
  let renewals = 0;
  let fetches = 0;
  const registry = new UsageSourceRegistry(() => now, 300_000, undefined, {
    hasAgent: () => true,
    usageSession: () => ({ provider: "claude", env: {}, sessionKey: "launch" }),
  });
  registry.register({
    id: "claude",
    label: "Claude",
    // The host's only login is the one the agent runs under, so both use one cache entry.
    discover: async (scope) => {
      if (scope.kind === "global") renewals++;
      await settle();
      now += 1_000;
      return [{ key: "account", input: "login" }];
    },
    fetch: async () => {
      fetches++;
      await settle();
      now += 500;
      return { status: "available", windows: [] };
    },
  });
  await registry.listReports();
  await registry.listReports({ agentId: "agent" });
  renewals = 0;
  fetches = 0;
  const waits: number[] = [];
  /** An hour of the agent's open usage details polling, with or without the host's polls. */
  const poll = async (from: number, host: boolean) => {
    for (let tick = from; tick < from + 2 * 60; tick++) {
      if (tick % 2 === 0 && !host) continue;
      now = Math.max(now, tick * 30_000);
      const asked = now;
      await registry.listReports(tick % 2 === 0 ? {} : { agentId: "agent" });
      waits.push(now - asked);
      for (let step = 0; step < 4; step++) await settle();
    }
  };
  // The host polls once a minute, and the agent's details half a minute after each.
  await poll(2, true);
  expect(waits.filter((wait) => wait > 0)).toEqual([]);
  expect(renewals).toBeGreaterThanOrEqual(11);
  expect(fetches).toBe(renewals);
  // Once nothing polls the host, the agent's details renew the entry themselves.
  fetches = 0;
  await poll(2 + 2 * 60, false);
  expect(waits.filter((wait) => wait > 0)).toEqual([]);
  expect(fetches).toBeGreaterThanOrEqual(11);
  expect(fetches).toBeLessThanOrEqual(13);
});

test("an agent's report is renewed behind its answer near the end of the cache window", async () => {
  let now = 0;
  let value = 1;
  const registry = new UsageSourceRegistry(() => now, 300_000, undefined, {
    hasAgent: () => true,
    usageSession: () => ({ provider: "codex", env: {}, sessionKey: "launch" }),
  });
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async (scope) => (scope.kind === "session" ? [{ key: "same", input: "agent" }] : []),
    fetch: async () => ({
      status: "available",
      windows: [{ id: "w", label: "w", usedPct: value }],
    }),
  });
  const usedPct = async () => {
    const [entry] = await registry.listReports({ agentId: "agent" });
    return entry?.report.status === "available" ? entry.report.windows[0]?.usedPct : undefined;
  };
  expect(await usedPct()).toBe(1);
  value = 2;
  now = 250_000;
  expect(await usedPct()).toBe(1);
  await settle();
  expect(await usedPct()).toBe(2);
});

test("each renewal logs one line with how long discovery and fetching took", async () => {
  let now = 0;
  const lines: unknown[][] = [];
  const registry = new UsageSourceRegistry(() => now, 300_000, {
    warn: () => {},
    info: (...args: unknown[]) => {
      lines.push(args);
    },
  });
  registry.register({
    ...source({
      id: "source",
      discover: async () => {
        now += 400;
        return ["a", "b"].map((key) => ({ key, input: key }));
      },
      fetch: async () => {
        now += 250;
        return { status: "available", windows: [] };
      },
    }),
    cacheGroup: "group",
  });
  await registry.listReports();
  await settle();
  now = 250_000;
  await registry.listReports();
  await settle();
  await registry.listReports({ forceRefresh: true });
  await settle();
  expect(lines).toEqual([
    [
      { group: "group", reason: "expired", discoveryMs: 400, fetchMs: 500, reports: 2 },
      "Usage source group renewed",
    ],
    [
      { group: "group", reason: "due", discoveryMs: 400, fetchMs: 500, reports: 2 },
      "Usage source group renewed",
    ],
    [
      { group: "group", reason: "forced", discoveryMs: 400, fetchMs: 500, reports: 2 },
      "Usage source group renewed",
    ],
  ]);
});

test("a renewal that lists no account is logged at debug unless a discovery took over 500ms", async () => {
  let now = 0;
  let discoveryMs = 30;
  const info: unknown[][] = [];
  const debug: unknown[][] = [];
  const registry = new UsageSourceRegistry(() => now, 300_000, {
    warn: () => {},
    info: (...args: unknown[]) => {
      info.push(args);
    },
    debug: (...args: unknown[]) => {
      debug.push(args);
    },
  });
  registry.register(
    source({
      id: "unused",
      discover: async () => {
        now += discoveryMs;
        return [];
      },
    }),
  );
  await registry.listReports();
  await settle();
  const quiet = { group: "unused", reason: "expired", discoveryMs: 30, fetchMs: 0, reports: 0 };
  expect(debug).toEqual([[quiet, "Usage source group renewed"]]);
  expect(info).toEqual([]);
  // A store that takes over half a second to say it holds nothing is still a cost worth reading.
  discoveryMs = 600;
  await registry.listReports({ forceRefresh: true });
  await settle();
  expect(info).toEqual([
    [
      {
        group: "unused",
        reason: "forced",
        discoveryMs: 600,
        fetchMs: 0,
        reports: 0,
        slowCalls: [
          { sourceId: "unused", phase: "discover", scope: "global", durationMs: 600, ok: true },
        ],
      },
      "Usage source group renewed",
    ],
  ]);
  expect(debug).toHaveLength(1);
});

test("a renewal names the source and phase of each call that took over 500ms", async () => {
  vi.useFakeTimers({ now: 0 });
  try {
    const lines: unknown[][] = [];
    const registry = new UsageSourceRegistry(() => Date.now(), 300_000, {
      warn: () => {},
      info: (...args: unknown[]) => {
        lines.push(args);
      },
    });
    const available = { status: "available", windows: [] };
    registry.register({
      ...source({
        id: "claude",
        discover: async () => {
          await delay(700);
          return [{ key: "work", label: "someone@example.com", input: { token: "work-token" } }];
        },
        fetch: async () => {
          await delay(900);
          return available;
        },
      }),
      cacheGroup: "claude-generation",
    });
    registry.register({
      ...source({
        id: "claude-windows",
        discover: async () => {
          await delay(100);
          return [{ key: "home", input: { token: "home-token" } }];
        },
        fetch: async () => {
          await delay(200);
          return available;
        },
      }),
      cacheGroup: "claude-generation",
    });

    const listed = registry.listReports();
    await vi.advanceTimersByTimeAsync(2_000);
    await listed;

    expect(lines).toEqual([
      [
        {
          group: "claude-generation",
          reason: "expired",
          discoveryMs: 700,
          fetchMs: 900,
          reports: 2,
          slowCalls: [
            { sourceId: "claude", phase: "discover", scope: "global", durationMs: 700, ok: true },
            { sourceId: "claude", phase: "fetch", durationMs: 900, ok: true },
          ],
        },
        "Usage source group renewed",
      ],
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/someone@example.com|work-token|home-token/);
  } finally {
    vi.useRealTimers();
  }
});

test("a session discovery or a fetch no renewal started logs its own line when over 500ms", async () => {
  vi.useFakeTimers({ now: 0 });
  try {
    const lines: unknown[][] = [];
    const registry = new UsageSourceRegistry(
      () => Date.now(),
      300_000,
      {
        warn: () => {},
        info: (...args: unknown[]) => {
          lines.push(args);
        },
      },
      {
        hasAgent: () => true,
        usageSession: () => ({ provider: "claude", sessionKey: "launch-1", env: {} }),
      },
    );
    registry.register(
      source({
        id: "claude",
        discover: async () => {
          await delay(650);
          return [{ key: "acct-7", label: "someone@example.com", input: { token: "secret" } }];
        },
        fetch: async () => {
          await delay(1_200);
          return { status: "available", windows: [] };
        },
      }),
    );
    registry.register(
      source({
        id: "codex",
        discover: async () => {
          await delay(100);
          return [{ key: "acct-8", input: { token: "other-secret" } }];
        },
        fetch: async () => {
          await delay(800);
          throw new Error("Usage endpoint rejected token other-secret");
        },
      }),
    );

    const listed = registry.listReports({ agentId: "agent-1" });
    await vi.advanceTimersByTimeAsync(3_000);
    await listed;

    expect(lines).toEqual([
      [
        { sourceId: "claude", phase: "discover", scope: "session", durationMs: 650, ok: true },
        "Usage source call slow",
      ],
      [{ sourceId: "codex", phase: "fetch", durationMs: 800, ok: false }, "Usage source call slow"],
      [
        { sourceId: "claude", phase: "fetch", durationMs: 1_200, ok: true },
        "Usage source call slow",
      ],
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/acct-|someone@example.com|secret/);
  } finally {
    vi.useRealTimers();
  }
});

test("an account added to the host appears on a forced refresh or once the cache window ends", async () => {
  let now = 0;
  const accounts: string[] = [];
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => accounts.map((key) => ({ key, input: key })),
    }),
  );
  const ids = async (forceRefresh?: boolean) =>
    (await registry.listReports({ forceRefresh })).map((report) => report.id);
  expect(await ids()).toEqual([]);
  accounts.push("a");
  // The window's last minute renews it ahead of its end; see the renewal tests.
  now = 239_999;
  expect(await ids()).toEqual([]);
  now = 300_000;
  expect(await ids()).toEqual(["source:a"]);
  accounts.push("b");
  now = 366_000;
  expect(await ids()).toEqual(["source:a"]);
  expect(await ids(true)).toEqual(["source:a", "source:b"]);
});

test("a renewal fetches every report of its group, so a report refreshed alone rejoins the group's window", async () => {
  let now = 0;
  let discoveries = 0;
  const fetched: unknown[] = [];
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => {
        discoveries++;
        return ["a", "b"].map((key) => ({ key, input: key }));
      },
      fetch: async (input) => {
        fetched.push(input);
        return { status: "available", windows: [] };
      },
    }),
  );
  await registry.listReports();
  now = 100_000;
  await registry.listReports({ reportIds: ["source:a"], forceRefresh: true });
  expect(discoveries).toBe(1);
  now = 300_000;
  await registry.listReports();
  expect(discoveries).toBe(2);
  expect(fetched).toEqual(["a", "b", "a", "a", "b"]);
  // Report "a" was fetched with "b" above, so its own window does not end here.
  now = 400_000;
  await registry.listReports();
  expect(discoveries).toBe(2);
  expect(fetched).toHaveLength(5);
});

test("a renewal the end of its discovery's window starts fetches the reports too, whose windows end a fetch later", async () => {
  let now = 0;
  const events: string[] = [];
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => {
        events.push(`discover@${now / 1_000}`);
        return [{ key: "account", input: "login" }];
      },
      // The vendor takes ten seconds, so the report's window ends that long after its discovery's.
      fetch: async () => {
        events.push(`fetch@${now / 1_000}`);
        await settle();
        now += 10_000;
        return { status: "available", windows: [] };
      },
    }),
  );
  await registry.listReports();
  // The discovery is in its window's last minute, and the report not yet.
  now = 245_000;
  await registry.listReports();
  await settle();
  // One renewal for the window: the next query neither discovers nor fetches again.
  now = 300_000;
  await registry.listReports();
  await settle();
  expect(events).toEqual(["discover@0", "fetch@0", "discover@245", "fetch@245"]);
});

test("a failed host discovery keeps the accounts and is asked again by the next query", async () => {
  let now = 0;
  let discoveryFails = false;
  let discoveries = 0;
  const registry = new UsageSourceRegistry(() => now, 300_000, { warn: () => {} });
  registry.register(
    source({
      id: "source",
      discover: async () => {
        discoveries++;
        if (discoveryFails) throw new Error("Login store temporarily unavailable");
        return [{ key: "account", input: {} }];
      },
    }),
  );
  await registry.listReports();
  now = 300_000;
  discoveryFails = true;
  expect((await registry.listReports()).map((report) => report.id)).toEqual(["source:account"]);
  expect(discoveries).toBe(2);
  discoveryFails = false;
  now = 300_001;
  await registry.listReports();
  expect(discoveries).toBe(3);
  await registry.listReports();
  expect(discoveries).toBe(3);
  // A forced refresh that fails inside the cache window leaves nothing to reuse either.
  discoveryFails = true;
  await registry.listReports({ forceRefresh: true });
  expect(discoveries).toBe(4);
  discoveryFails = false;
  expect((await registry.listReports()).map((report) => report.id)).toEqual(["source:account"]);
  expect(discoveries).toBe(5);
  await registry.listReports();
  expect(discoveries).toBe(5);
});

test("while the login store cannot be read, renewals fetch each account once per cache window with its last login, behind the polls' answers", async () => {
  let now = 0;
  let storeFails = false;
  let discoveries = 0;
  const fetched: Array<{ input: string; at: number }> = [];
  const warnings: unknown[] = [];
  const registry = new UsageSourceRegistry(() => now, 300_000, {
    warn: (...args: unknown[]) => {
      warnings.push(args[1]);
    },
  });
  registry.register(
    source({
      id: "source",
      // Each takes its time after the query that started it has had its chance to answer.
      discover: async () => {
        discoveries++;
        await settle();
        now += 1_000;
        if (storeFails) throw new Error("Login store temporarily unavailable");
        return ["a", "b"].map((key) => ({ key, input: key }));
      },
      fetch: async (input) => {
        fetched.push({ input: String(input), at: now });
        await settle();
        now += 500;
        return { status: "available", windows: [] };
      },
    }),
  );
  await registry.listReports();
  storeFails = true;
  discoveries = 0;
  fetched.length = 0;
  const waits: number[] = [];
  let firstRenewalSeen = false;
  // An app window polls once a minute for a quarter of an hour, and the store fails every read.
  for (let minute = 1; minute <= 15; minute++) {
    now = Math.max(now, minute * 60_000);
    const asked = now;
    const before = discoveries;
    const reports = await registry.listReports();
    waits.push(now - asked);
    // The accounts the store named before stay listed.
    expect(reports.map((report) => report.id)).toEqual(["source:a", "source:b"]);
    for (let step = 0; step < 4; step++) await settle();
    if (before === 0 && discoveries > 0) {
      // The poll that started the first renewal was answered from the cache, and the renewal still
      // fetched both reports, near the end of their window, with the logins named before.
      firstRenewalSeen = true;
      expect(waits.at(-1)).toBe(0);
      expect(warnings).toEqual(["Usage source discovery failed"]);
      expect(fetched.map((fetch) => fetch.input)).toEqual(["a", "b"]);
    }
  }
  expect(firstRenewalSeen).toBe(true);
  // Once the store's last answer is a window old, a poll waits for the store to fail again, but no
  // poll waits for the vendor.
  expect(waits.filter((wait) => wait > 1_000)).toEqual([]);
  // Each account reaches the vendor once per cache window, not on every failed renewal.
  expect(fetched.map((fetch) => `${fetch.input}@${fetch.at / 1_000}s`)).toEqual([
    "a@301s",
    "b@301s",
    "a@601s",
    "b@601s",
    "a@901s",
    "b@901s",
  ]);
  // Every failed store read is logged.
  expect(warnings).toEqual(
    Array.from({ length: discoveries }, () => "Usage source discovery failed"),
  );
});

test.each([
  ["never reads its store", 0],
  ["fails after its first read", 1],
])(
  "while a sibling in the cache group %s, each account reaches the vendor once per cache window and no poll waits for it",
  async (_case, siblingReads) => {
    let now = 0;
    let reads = siblingReads;
    const fetched: Array<{ input: string; at: number }> = [];
    const registry = new UsageSourceRegistry(() => now, 300_000, { warn: () => {} });
    const accounts = ["a", "b"].map((key) => ({ key, input: key }));
    const vendor = async (input: unknown) => {
      fetched.push({ input: String(input), at: now });
      await settle();
      now += 500;
      return { status: "available", windows: [] };
    };
    // Like the built-in Claude sources: both name the same logins under one label, so each account
    // has one fetch for both, and the second source's own settings cannot be read.
    registry.register({
      id: "claude",
      cacheGroup: "claude",
      label: "Claude",
      discover: async () => {
        await settle();
        now += 1_000;
        return accounts;
      },
      fetch: vendor,
    });
    registry.register({
      id: "claude-windows",
      cacheGroup: "claude",
      label: "Claude",
      discover: async () => {
        if (reads-- > 0) return accounts;
        throw new Error("Invalid Windows usage compatibility setting");
      },
      fetch: vendor,
    });
    await registry.listReports();
    fetched.length = 0;
    const waits: number[] = [];
    let oldest = 0;
    // An app window polls once a minute for an hour.
    for (let minute = 1; minute <= 60; minute++) {
      now = Math.max(now, minute * 60_000);
      const asked = now;
      const reports = await registry.listReports();
      waits.push(now - asked);
      expect(reports.map((report) => report.id)).toEqual(
        expect.arrayContaining(["claude:a", "claude:b"]),
      );
      for (const report of reports) oldest = Math.max(oldest, asked - Date.parse(report.fetchedAt));
      for (let step = 0; step < 4; step++) await settle();
    }
    // A poll may wait for the store read the sibling needs again, never for the vendor.
    expect(waits.filter((wait) => wait > 1_000)).toEqual([]);
    // The accounts are still renewed: no poll is answered with a report older than the window.
    expect(oldest).toBeLessThanOrEqual(300_000);
    for (const account of ["a", "b"]) {
      const at = fetched.filter((call) => call.input === account).map((call) => call.at);
      // Twelve cache windows in the hour, and each fetch at most a minute before its window ends.
      expect(at.length).toBeLessThanOrEqual(12);
      expect(
        Math.min(...at.slice(1).map((time, index) => time - at[index]!)),
      ).toBeGreaterThanOrEqual(240_000);
    }
  },
);

test("while a sibling in the cache group cannot be read, a report refreshed alone still rejoins its group's window", async () => {
  let now = 0;
  const fetched: string[] = [];
  const registry = new UsageSourceRegistry(() => now, 300_000, { warn: () => {} });
  registry.register({
    id: "claude",
    cacheGroup: "claude",
    label: "Claude",
    discover: async () => ["a", "b"].map((key) => ({ key, input: key })),
    fetch: async (input) => {
      fetched.push(`${String(input)}@${now / 1_000}`);
      return { status: "available", windows: [] };
    },
  });
  registry.register({
    id: "claude-windows",
    cacheGroup: "claude",
    label: "Claude",
    discover: async () => {
      throw new Error("Invalid Windows usage compatibility setting");
    },
    fetch: async () => ({ status: "available", windows: [] }),
  });
  await registry.listReports();
  now = 30_000;
  await registry.listReports({ reportIds: ["claude:a"], forceRefresh: true });
  // An app window polls once a minute, and every poll asks the failing source again.
  for (let minute = 1; minute <= 10; minute++) {
    now = minute * 60_000;
    await registry.listReports();
    await settle();
  }
  // "b" reaching the last minute of its window renews "a" with it, once per window after that.
  expect(fetched).toEqual(["a@0", "b@0", "a@30", "a@240", "b@240", "a@480", "b@480"]);
});

test("while a sibling in the cache group cannot be read, a store read slower than the last does not split its group's fetches", async () => {
  let now = 0;
  let readMs = 1_000;
  const fetched: string[] = [];
  // The vendor answers "a" in a quarter of a second and "b" in a second.
  const answerMs: Record<string, number> = { a: 250, b: 1_000 };
  const registry = new UsageSourceRegistry(() => now, 300_000, { warn: () => {} });
  registry.register({
    id: "claude",
    cacheGroup: "claude",
    label: "Claude",
    discover: async () => {
      await settle();
      now += readMs;
      return ["a", "b"].map((key) => ({ key, input: key }));
    },
    fetch: async (input) => {
      fetched.push(`${String(input)}@${now / 1_000}`);
      await settle();
      now += answerMs[String(input)]!;
      return { status: "available", windows: [] };
    },
  });
  registry.register({
    id: "claude-windows",
    cacheGroup: "claude",
    label: "Claude",
    discover: async () => {
      throw new Error("Invalid Windows usage compatibility setting");
    },
    fetch: async () => ({ status: "available", windows: [] }),
  });
  await registry.listReports();
  // An app window polls once a minute, and every poll asks the failing source again. One store
  // read takes half a second longer, long enough for "a" but not "b" to reach its window's last
  // minute while it runs.
  for (let minute = 1; minute <= 10; minute++) {
    now = Math.max(now, minute * 60_000);
    readMs = minute === 4 ? 1_500 : 1_000;
    await registry.listReports();
    for (let step = 0; step < 4; step++) await settle();
  }
  // "a" is renewed with "b" rather than alone and then again with "b" a minute later.
  expect(fetched).toEqual(["a@1", "b@1", "a@241.5", "b@241.5", "a@541", "b@541"]);
});

test("a forced refresh that meets a running discovery is answered by one started after it", async () => {
  let now = 0;
  const store: string[] = [];
  const answers: Array<() => void> = [];
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: () => {
        // The login store is read when the discovery starts, not when it answers.
        const accounts = store.map((key) => ({ key, input: key }));
        return new Promise((resolve) => {
          answers.push(() => resolve(accounts));
        });
      },
    }),
  );
  const ids = async (query: ReturnType<typeof registry.listReports>) =>
    (await query).map((report) => report.id);
  const polled = registry.listReports();
  store.push("a");
  const forced = [1, 2, 3].map(() => registry.listReports({ forceRefresh: true }));
  expect(answers).toHaveLength(1);
  answers[0]!();
  expect(await ids(polled)).toEqual([]);
  await vi.waitFor(() => expect(answers).toHaveLength(2));
  answers[1]!();
  expect(await Promise.all(forced.map(ids))).toEqual([["source:a"], ["source:a"], ["source:a"]]);
  now = 66_000;
  expect(await ids(registry.listReports())).toEqual(["source:a"]);
  expect(answers).toHaveLength(2);
});

test("sources in one cache group are discovered together, so a forced refresh cannot join a sibling's earlier read", async () => {
  let now = 0;
  let reads = 0;
  let release = () => {};
  let held: Promise<void> | undefined;
  let reading: Promise<string[]> | undefined;
  const store = ["shared"];
  const asked: string[] = [];
  // Like the built-in Claude sources: one store read answers every source that asks while it runs.
  const read = (id: string) => {
    asked.push(id);
    reading ??= (async () => {
      reads++;
      const logins = [...store];
      await held;
      return logins;
    })().finally(() => {
      reading = undefined;
    });
    return reading;
  };
  const registry = new UsageSourceRegistry(() => now);
  const account = (key: string) => ({ key, input: key });
  registry.register({
    ...source({ id: "all", discover: async () => [...(await read("all")), "own"].map(account) }),
    cacheGroup: "group",
  });
  registry.register({
    ...source({ id: "some", discover: async () => (await read("some")).map(account) }),
    cacheGroup: "group",
  });
  await registry.listReports();
  expect(asked).toEqual(["all", "some"]);
  // "all:own" is younger than the others here, and it belongs to one of the two sources.
  now = 100_000;
  await registry.listReports({ reportIds: ["all:own"], forceRefresh: true });
  now = 300_000;
  await registry.listReports();
  expect(asked).toEqual(["all", "some", "all", "some"]);
  now = 600_000;
  held = new Promise((resolve) => {
    release = resolve;
  });
  const polled = registry.listReports();
  expect(asked).toEqual(["all", "some", "all", "some", "all", "some"]);
  expect(reads).toBe(3);
  store.push("new");
  const forced = registry.listReports({ forceRefresh: true });
  release();
  await polled;
  expect((await forced).map((report) => report.id).sort()).toEqual([
    "all:new",
    "all:own",
    "all:shared",
    "some:new",
    "some:shared",
  ]);
  expect(reads).toBe(4);
});

test("a forced refresh waiting on a running discovery does not ask a source removed meanwhile", async () => {
  let finish = () => {};
  let discoveries = 0;
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: () => {
        discoveries++;
        return new Promise((resolve) => {
          finish = () => resolve([{ key: "one", input: {} }]);
        });
      },
    }),
  );
  const polled = registry.listReports();
  const forced = registry.listReports({ forceRefresh: true });
  registry.unregister("source");
  finish();
  expect(await polled).toEqual([]);
  expect(await forced).toEqual([]);
  expect(discoveries).toBe(1);
});

/** A source whose fetch, like the Claude source on Windows, uses the token read as it starts. */
function loginBoundSource() {
  const state = { login: "old" };
  const fetches: Array<{ login: string; answer: (report: unknown) => void }> = [];
  const registered = source({
    id: "source",
    discover: async () => [{ key: "a", input: "a" }],
    fetch: () => {
      const login = state.login;
      return new Promise((resolve) => fetches.push({ login, answer: resolve }));
    },
  });
  return { state, fetches, registered };
}

const signedIn = (login: string) => ({ status: "available", planLabel: login, windows: [] });
const signedInAs = (reports: Awaited<ReturnType<UsageSourceRegistry["listReports"]>>) =>
  reports.map((entry) =>
    entry.report.status === "available" ? entry.report.planLabel : entry.report.status,
  );

test("a forced refresh after a login change does not take a renewal's fetch made with the old token", async () => {
  let now = 0;
  const { state, fetches, registered } = loginBoundSource();
  const registry = new UsageSourceRegistry(() => now);
  registry.register(registered);
  const first = registry.listReports();
  await vi.waitFor(() => expect(fetches).toHaveLength(1));
  fetches[0]!.answer(signedIn("old"));
  await first;
  // Near the window's end a poll is answered from the cache and renews the group behind it.
  now = 250_000;
  expect(signedInAs(await registry.listReports())).toEqual(["old"]);
  await vi.waitFor(() => expect(fetches).toHaveLength(2));
  // Settings Sync restores another token while that renewal's fetch is still out.
  state.login = "new";
  const forced = registry.listReports({ forceRefresh: true });
  await vi.waitFor(() => expect(fetches).toHaveLength(3));
  expect(fetches.map((fetch) => fetch.login)).toEqual(["old", "old", "new"]);
  fetches[2]!.answer(signedIn("new"));
  // The vendor rejects the replaced token, and that answer arrives last.
  fetches[1]!.answer({ status: "error", error: "HTTP 401" });
  expect(signedInAs(await forced)).toEqual(["new"]);
  // Nor does the late answer replace the forced one in the cache.
  expect(signedInAs(await registry.listReports())).toEqual(["new"]);
  expect(fetches).toHaveLength(3);
});

test("a forced refresh of chosen reports does not join a fetch that started before it", async () => {
  const { state, fetches, registered } = loginBoundSource();
  const registry = new UsageSourceRegistry();
  registry.register(registered);
  const polled = registry.listReports();
  await vi.waitFor(() => expect(fetches).toHaveLength(1));
  state.login = "new";
  const forced = registry.listReports({ reportIds: ["source:a"], forceRefresh: true });
  await vi.waitFor(() => expect(fetches).toHaveLength(2));
  fetches[1]!.answer(signedIn("new"));
  fetches[0]!.answer({ status: "error", error: "HTTP 401" });
  expect(signedInAs(await forced)).toEqual(["new"]);
  // The poll asked before the change and keeps the answer of the fetch it joined.
  expect(signedInAs(await polled)).toEqual(["error"]);
  expect(signedInAs(await registry.listReports())).toEqual(["new"]);
});
