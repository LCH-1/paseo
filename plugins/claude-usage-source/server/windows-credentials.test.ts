import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWindowsCredentials, type ReadCredentials } from "./windows-credentials.js";
import { discover, fetchUsage, profilesForProviders, resolveClaudeCredentials } from "./usage.js";
import { hashAccountKey } from "@getpaseo/plugin/server/usage";
import { inputSchema } from "../shared/input.js";
import {
  CLEARED,
  DAEMON_LOGIN,
  FRESH_INSTALL,
  NO_LOGIN,
  REJECTED,
  UNREACHABLE,
  login,
  profileApi,
  providers,
  serviceFor,
  windowsHost,
} from "../test/windows-host.js";

/** A stand-in for the PowerShell helper: every call is one process answering all its targets. */
function helperProcess(read: (target: string) => string | null | undefined) {
  const starts: string[][] = [];
  const readCredentials: ReadCredentials = async (targets) => {
    starts.push(targets);
    return targets.map((target) => read(target) ?? null);
  };
  return { starts, readCredentials };
}

describe("Claude Windows credentials", () => {
  it("does not revive stale file tokens after the CLI cleared the Windows entry", async () => {
    const home = mkdtempSync(join(tmpdir(), "claude-no-stale-fallback-"));
    try {
      writeFileSync(
        join(home, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "stale-file-token" } }),
      );
      const env = { CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home };
      const lookup = {
        home,
        env,
        platform: "win32" as const,
        readWindowsCredentials: async () => ({
          claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 },
        }),
      };
      const accounts = await discover({ kind: "session", provider: "claude", env }, lookup);
      expect(accounts).toHaveLength(1);
      expect(inputSchema.parse(accounts[0].input).route.store).toBe("windows-credman");
      expect(
        await resolveClaudeCredentials(inputSchema.parse(accounts[0].input), lookup),
      ).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("matches the official CLI file fallback when Windows has no entry", async () => {
    const home = mkdtempSync(join(tmpdir(), "claude-missing-store-fallback-"));
    try {
      writeFileSync(
        join(home, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "isolated-file-fallback", expiresAt: 0 } }),
      );
      const env = {
        CLAUDE_CONFIG_DIR: home,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: home,
        CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1",
      };
      const accounts = await discover(
        { kind: "session", provider: "claude", env },
        { home, env, platform: "win32", readWindowsCredentials: async () => null },
      );
      expect(accounts).toHaveLength(1);
      expect(inputSchema.parse(accounts[0].input).route.store).toBe("claude");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("keeps a broken account diagnostic without hiding another configured account", async () => {
    const home = mkdtempSync(join(tmpdir(), "claude-isolated-accounts-"));
    try {
      mkdirSync(join(home, ".paseo"));
      const profile = join(home, "second");
      writeFileSync(
        join(home, ".paseo", "config.json"),
        JSON.stringify({
          agents: {
            providers: {
              claude: { env: { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1" } },
              second: {
                extends: "claude",
                env: { CLAUDE_CONFIG_DIR: profile, CLAUDE_SECURESTORAGE_CONFIG_DIR: profile },
              },
            },
          },
        }),
      );
      const lookup = {
        home,
        env: { USERPROFILE: home },
        platform: "win32" as const,
        readWindowsCredentials: async (service: string) => {
          if (service === "Claude Code-credentials")
            throw new Error("Incomplete split Claude Windows credentials");
          return {
            claudeAiOauth: {
              accessToken: "isolated-healthy-account",
              expiresAt: Date.now() + 600_000,
            },
          };
        },
      };
      const fetchApi = async () =>
        Response.json({
          account: { uuid: "healthy", email: "healthy@example.test" },
          organization: { uuid: "org" },
        });
      const accounts = await discover({ kind: "global" }, lookup, fetchApi);
      expect(accounts).toHaveLength(2);
      expect(accounts.some((account) => account.label === "healthy@example.test")).toBe(true);
      const broken = accounts.find((account) => account.label === undefined)!;
      await expect(fetchUsage(inputSchema.parse(broken.input), fetchApi, lookup)).rejects.toThrow(
        "Incomplete",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("retries a partial split read during a writer transition", async () => {
    const value = { claudeAiOauth: { accessToken: "isolated-transition" } };
    const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
    let pass = 0;
    const helper = helperProcess((name) => {
      if (name.endsWith("#m")) {
        pass++;
        return JSON.stringify({ n: 1, l: encoded.length });
      }
      return pass === 1 ? null : encoded;
    });
    const result = await readWindowsCredentials("fixture", helper.readCredentials);
    expect(result).toEqual(value);
  });
  it("reads legacy and split records without writing", async () => {
    const value = { claudeAiOauth: { accessToken: "fixture-only" } };
    const legacy = helperProcess((name) => (name.endsWith("#m") ? null : JSON.stringify(value)));
    expect(await readWindowsCredentials("fixture", legacy.readCredentials)).toEqual(value);
    const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
    const chunks = [encoded.slice(0, 20), encoded.slice(20)];
    const split = helperProcess((name) =>
      name.endsWith("#m")
        ? JSON.stringify({ n: 2, l: encoded.length })
        : chunks[Number(name.at(-1))],
    );
    expect(await readWindowsCredentials("fixture", split.readCredentials)).toEqual(value);
    const incomplete = helperProcess((name) =>
      name.endsWith("#m") ? JSON.stringify({ n: 2, l: encoded.length }) : null,
    );
    await expect(readWindowsCredentials("fixture", incomplete.readCredentials)).rejects.toThrow(
      "Incomplete",
    );
  });
  it("starts one helper process for an unsplit or missing login and two for a split one", async () => {
    const value = { claudeAiOauth: { accessToken: "fixture-only" } };
    const name = "fixture/claude-code-user";
    const legacy = helperProcess((target) => (target === name ? JSON.stringify(value) : null));
    await readWindowsCredentials("fixture", legacy.readCredentials);
    expect(legacy.starts).toEqual([[name + "#m", name]]);
    const missing = helperProcess(() => null);
    expect(await readWindowsCredentials("fixture", missing.readCredentials)).toBeNull();
    expect(missing.starts).toEqual([[name + "#m", name]]);
    const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
    const chunks = [encoded.slice(0, 20), encoded.slice(20)];
    const split = helperProcess((target) =>
      target.endsWith("#m")
        ? JSON.stringify({ n: 2, l: encoded.length })
        : chunks[Number(target.at(-1))],
    );
    await readWindowsCredentials("fixture", split.readCredentials);
    expect(split.starts).toEqual([
      [name + "#m", name],
      [name + "#0", name + "#1", name + "#m"],
    ]);
  });
  it("rejects a split login whose metadata changes while its chunks are read", async () => {
    const encoded = Buffer.from(JSON.stringify({ claudeAiOauth: {} })).toString("base64");
    let metadataReads = 0;
    const helper = helperProcess((name) =>
      name.endsWith("#m")
        ? JSON.stringify({ n: 1, l: encoded.length, v: metadataReads++ })
        : encoded,
    );
    await expect(readWindowsCredentials("fixture", helper.readCredentials)).rejects.toThrow(
      "Changed",
    );
  });
  it("rejects invalid split metadata and returns null for missing credentials", async () => {
    expect(
      await readWindowsCredentials("fixture", helperProcess(() => null).readCredentials),
    ).toBeNull();
    for (const n of [0, -1, 257, 1.5])
      await expect(
        readWindowsCredentials(
          "fixture",
          helperProcess(() => JSON.stringify({ n, l: 1 })).readCredentials,
        ),
      ).rejects.toThrow("metadata");
  });
  it("re-reads Windows tokens on fetch and preserves quota windows", async () => {
    let current = "fixture-a";
    const input = { route: { store: "windows-credman" as const, service: "fixture" } };
    const lookup = {
      platform: "win32" as const,
      readWindowsCredentials: async () => ({
        claudeAiOauth: { accessToken: current, expiresAt: Date.now() + 100_000 },
      }),
    };
    expect((await resolveClaudeCredentials(input, lookup))?.oauth.accessToken).toBe("fixture-a");
    current = "fixture-b";
    const result = await fetchUsage(
      input,
      async (_url, options) => {
        expect(options?.headers).toHaveProperty("Authorization", "Bearer fixture-b");
        return Response.json({
          five_hour: { utilization: 20, resets_at: "2026-10-27T00:00:00Z" },
          seven_day: { utilization: 30, resets_at: "2026-10-30T00:00:00Z" },
        });
      },
      lookup,
    );
    expect(result.status).toBe("available");
    if (result.status === "available")
      expect(result.windows.map((window) => window.usedPct)).toEqual([20, 30]);
  });
  it("discovers configured aliases in Windows secure storage and respects default storage override", async () => {
    const home = mkdtempSync(join(tmpdir(), "claude-windows-usage-"));
    try {
      mkdirSync(join(home, ".paseo"));
      const config = join(home, "profile");
      writeFileSync(
        join(home, ".paseo", "config.json"),
        JSON.stringify({
          agents: {
            providers: {
              claude: {},
              "claude-fixture": {
                extends: "claude",
                env: { CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: config },
              },
            },
          },
        }),
      );
      const seen: string[] = [];
      const read = async (service: string) => {
        seen.push(service);
        return { claudeAiOauth: { accessToken: "fixture-only", expiresAt: 0 } };
      };
      const lookup = {
        home,
        env: { USERPROFILE: home },
        platform: "win32" as const,
        readWindowsCredentials: read,
      };
      const accounts = await discover({ kind: "global" }, lookup, async () => {
        throw new Error("expired fixture must not fetch");
      });
      expect(accounts).toHaveLength(2);
      expect(seen).toContain(
        "Claude Code-credentials-" + hashAccountKey(config.normalize("NFC")).slice(0, 8),
      );
      seen.length = 0;
      await discover(
        {
          kind: "session",
          provider: "claude",
          env: { CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: "" },
        },
        lookup,
      );
      expect(seen).toContain("Claude Code-credentials");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("reads each Windows service once when discovering accounts or reading provider profiles", async () => {
    const home = mkdtempSync(join(tmpdir(), "claude-windows-reads-"));
    try {
      mkdirSync(join(home, ".paseo"));
      const config = join(home, "profile");
      writeFileSync(
        join(home, ".paseo", "config.json"),
        JSON.stringify({
          agents: {
            providers: {
              claude: {},
              "claude-fixture": {
                extends: "claude",
                env: { CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: config },
              },
            },
          },
        }),
      );
      const seen: string[] = [];
      const lookup = {
        home,
        env: { USERPROFILE: home },
        platform: "win32" as const,
        readWindowsCredentials: async (service: string) => {
          seen.push(service);
          return {
            claudeAiOauth: {
              accessToken: "isolated-once-" + service,
              expiresAt: Date.now() + 600_000,
            },
          };
        },
      };
      const fetchApi = async () =>
        Response.json({ account: { uuid: "once" }, organization: { uuid: "org" } });
      const services = [
        "Claude Code-credentials",
        "Claude Code-credentials-" + hashAccountKey(config.normalize("NFC")).slice(0, 8),
      ];
      expect(await discover({ kind: "global" }, lookup, fetchApi)).toHaveLength(2);
      expect(seen.toSorted()).toEqual(services);
      seen.length = 0;
      const profiles = await profilesForProviders(["claude", "claude-fixture"], fetchApi, lookup);
      expect(profiles.map((profile) => profile.status)).toEqual(["ready", "ready"]);
      expect(seen.toSorted()).toEqual(services);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("gives a failed Windows read its second attempt within one discovery", async () => {
    const env = {
      CLAUDE_CONFIG_DIR: "C:/fixture/second-attempt",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "C:/fixture/second-attempt",
    };
    let reads = 0;
    const accounts = await discover(
      { kind: "session", provider: "claude", env },
      {
        env,
        platform: "win32",
        readWindowsCredentials: async () => {
          reads++;
          if (reads === 1) throw new Error("Claude Windows credential store could not be read");
          return {
            claudeAiOauth: {
              accessToken: "isolated-second-attempt",
              expiresAt: Date.now() + 600_000,
            },
          };
        },
      },
      async () =>
        Response.json({
          account: { uuid: "second-attempt", email: "second-attempt@example.test" },
          organization: { uuid: "org" },
        }),
    );
    expect(accounts.map((account) => account.label)).toEqual(["second-attempt@example.test"]);
    expect(reads).toBe(2);
  });
  it("reports a cleared login as an error logged once, and recovers when the login returns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let token = "";
      const input = { route: { store: "windows-credman" as const, service: "cleared-fixture" } };
      const lookup = {
        platform: "win32" as const,
        readWindowsCredentials: async () => ({
          claudeAiOauth: { accessToken: token, expiresAt: token ? Date.now() + 100_000 : 0 },
        }),
      };
      let fetches = 0;
      const fetchApi = async () => {
        fetches++;
        return Response.json({ five_hour: { utilization: 20, resets_at: "2026-10-27T00:00:00Z" } });
      };
      const cleared = { status: "error", error: "Claude login store no longer exists" };
      expect(await fetchUsage(input, fetchApi, lookup)).toEqual(cleared);
      expect(await fetchUsage(input, fetchApi, lookup)).toEqual(cleared);
      expect(fetches).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      token = "isolated-returned-login";
      expect((await fetchUsage(input, fetchApi, lookup)).status).toBe("available");
      token = "";
      expect(await fetchUsage(input, fetchApi, lookup)).toEqual(cleared);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the daemon's own Windows login", () => {
  const FIRST = "C:/fixture/provider-profiles/first";
  const SECOND = "C:/fixture/provider-profiles/second";
  const DAEMON_DIR = "C:/fixture/daemon-config";
  const GATEWAY = { ANTHROPIC_BASE_URL: "https://gateway.example.test/anthropic" };
  const second = { extends: "claude", env: { CLAUDE_CONFIG_DIR: SECOND } };
  // Both providers sign in through their own config directory, so neither uses the daemon's login.
  const OWN_LOGINS = providers({ claude: { env: { CLAUDE_CONFIG_DIR: FIRST } }, second });
  const providerLogins = {
    [serviceFor(FIRST)]: login("isolated-first"),
    [serviceFor(SECOND)]: login("isolated-second"),
  };
  // Logins the vendor has not said the owner of.
  const UNIDENTIFIED = [
    ["an expired login", { claudeAiOauth: { accessToken: "isolated-expired", expiresAt: 0 } }],
    ["a login the vendor rejects", login(REJECTED)],
    ["a login whose owner cannot be looked up", login(UNREACHABLE)],
  ];

  /** The environment of a provider that keeps everything about its login under one directory. */
  function pinned(configDir: string) {
    return {
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir,
      CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1",
    };
  }

  async function listedServices(lookup: ReturnType<typeof windowsHost>) {
    const accounts = await discover({ kind: "global" }, lookup, profileApi);
    return accounts.map((account) => {
      const { route } = inputSchema.parse(account.input);
      return route.store === "windows-credman" ? route.service : route.store;
    });
  }

  it.each([
    ["every provider has its own config directory", OWN_LOGINS],
    [
      "every provider pins its config directory, secure storage and credential store",
      providers({
        claude: { env: pinned(FIRST) },
        second: { extends: "claude", env: pinned(SECOND) },
      }),
    ],
    [
      "the built-in provider is disabled",
      providers({
        claude: { enabled: false },
        first: { extends: "claude", env: { CLAUDE_CONFIG_DIR: FIRST } },
        second,
      }),
    ],
  ])("is not an account while it is empty and no provider uses it: %s", async (_case, config) => {
    const lookup = windowsHost(config, { [DAEMON_LOGIN]: NO_LOGIN, ...providerLogins });
    expect(await listedServices(lookup)).toEqual([serviceFor(FIRST), serviceFor(SECOND)]);
  });

  it("is not an account while it cannot be read and no provider uses it", async () => {
    const lookup = windowsHost(OWN_LOGINS, {
      [DAEMON_LOGIN]: new Error("Incomplete split Claude Windows credentials"),
      ...providerLogins,
    });
    expect(await listedServices(lookup)).toEqual([serviceFor(FIRST), serviceFor(SECOND)]);
  });

  it.each(UNIDENTIFIED)(
    "is not an account while it holds %s and no provider uses it",
    async (_case, held) => {
      const lookup = windowsHost(OWN_LOGINS, { [DAEMON_LOGIN]: held, ...providerLogins });
      expect(await listedServices(lookup)).toEqual([serviceFor(FIRST), serviceFor(SECOND)]);
    },
  );

  it("is an account once the vendor identifies its login, even when no provider uses it", async () => {
    const lookup = windowsHost(OWN_LOGINS, {
      [DAEMON_LOGIN]: login("isolated-daemon"),
      ...providerLogins,
    });
    expect(await listedServices(lookup)).toEqual([
      DAEMON_LOGIN,
      serviceFor(FIRST),
      serviceFor(SECOND),
    ]);
  });

  it("is the login of the daemon's own config directory when the daemon runs with one", async () => {
    const store = { [serviceFor(DAEMON_DIR)]: NO_LOGIN, ...providerLogins };
    const env = { CLAUDE_CONFIG_DIR: DAEMON_DIR };
    expect(await listedServices(windowsHost(OWN_LOGINS, store, env))).toEqual([
      serviceFor(FIRST),
      serviceFor(SECOND),
    ]);
    const inherited = providers({ claude: {}, second });
    expect(await listedServices(windowsHost(inherited, store, env))).toEqual([
      serviceFor(DAEMON_DIR),
      serviceFor(SECOND),
    ]);
  });

  it.each([
    ["no config file", null, [DAEMON_LOGIN]],
    ["the config file of a fresh install", FRESH_INSTALL, [DAEMON_LOGIN]],
    [
      "no entry for the built-in provider",
      providers({ second }),
      [DAEMON_LOGIN, serviceFor(SECOND)],
    ],
    [
      "a built-in provider entry without a config directory",
      providers({ claude: {}, second }),
      [DAEMON_LOGIN, serviceFor(SECOND)],
    ],
    [
      "a derived provider without a config directory",
      providers({ claude: { enabled: false }, work: { extends: "claude" }, second }),
      [DAEMON_LOGIN, serviceFor(SECOND)],
    ],
    [
      "a provider whose secure storage stays on the daemon's login",
      providers({
        claude: { env: { CLAUDE_CONFIG_DIR: FIRST, CLAUDE_SECURESTORAGE_CONFIG_DIR: "" } },
      }),
      [DAEMON_LOGIN],
    ],
  ])(
    "stays a reported account while a provider signs in through it: %s",
    async (_case, config, listed) => {
      const lookup = windowsHost(config, {
        [DAEMON_LOGIN]: NO_LOGIN,
        [serviceFor(SECOND)]: login("isolated-second"),
      });
      expect(await listedServices(lookup)).toEqual(listed);
      expect(
        await fetchUsage(
          { route: { store: "windows-credman", service: DAEMON_LOGIN } },
          profileApi,
          lookup,
        ),
      ).toEqual(CLEARED);
    },
  );

  it.each(UNIDENTIFIED)(
    "stays a reported account while it holds %s and a provider signs in through it",
    async (_case, held) => {
      const lookup = windowsHost(providers({ claude: {}, second }), {
        [DAEMON_LOGIN]: held,
        [serviceFor(SECOND)]: login("isolated-second"),
      });
      expect(await listedServices(lookup)).toEqual([DAEMON_LOGIN, serviceFor(SECOND)]);
    },
  );

  it("keeps reporting a provider's cleared login", async () => {
    const lookup = windowsHost(OWN_LOGINS, {
      [DAEMON_LOGIN]: NO_LOGIN,
      ...providerLogins,
      [serviceFor(SECOND)]: { claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } },
    });
    expect(await listedServices(lookup)).toEqual([serviceFor(FIRST), serviceFor(SECOND)]);
    expect(
      await fetchUsage(
        { route: { store: "windows-credman", service: serviceFor(SECOND) } },
        profileApi,
        lookup,
      ),
    ).toEqual(CLEARED);
  });

  it("keeps reporting a provider's unreadable login", async () => {
    const lookup = windowsHost(OWN_LOGINS, {
      [DAEMON_LOGIN]: NO_LOGIN,
      ...providerLogins,
      [serviceFor(SECOND)]: new Error("Incomplete split Claude Windows credentials"),
    });
    expect(await listedServices(lookup)).toEqual([serviceFor(FIRST), serviceFor(SECOND)]);
  });

  it.each([
    GATEWAY,
    { CLAUDE_CODE_USE_BEDROCK: "1" },
    { CLAUDE_CODE_USE_BEDROCK: "true" },
    { CLAUDE_CODE_USE_VERTEX: "yes" },
  ])(
    "is not kept listed by a provider that authenticates without a Claude login: %o",
    async (env) => {
      const lookup = windowsHost(
        providers({ claude: { enabled: false }, gateway: { extends: "claude", env }, second }),
        { [DAEMON_LOGIN]: NO_LOGIN, [serviceFor(SECOND)]: login("isolated-second") },
      );
      expect(await listedServices(lookup)).toEqual([serviceFor(SECOND)]);
    },
  );

  it.each([
    ["no config file", null],
    ["a built-in provider entry that inherits the daemon's endpoint", providers({ claude: {} })],
  ])(
    "is not kept listed while the daemon authenticates without a Claude login: %s",
    async (_case, config) => {
      const lookup = windowsHost(config, { [DAEMON_LOGIN]: NO_LOGIN }, GATEWAY);
      expect(await listedServices(lookup)).toEqual([]);
    },
  );

  it("stays a reported account while a provider returns the daemon's endpoint to the vendor's own", async () => {
    const lookup = windowsHost(
      providers({
        work: { extends: "claude", env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com/" } },
      }),
      { [DAEMON_LOGIN]: NO_LOGIN },
      GATEWAY,
    );
    expect(await listedServices(lookup)).toEqual([DAEMON_LOGIN]);
  });
});
