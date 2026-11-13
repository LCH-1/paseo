import { expect, it, vi } from "vitest";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server/usage";
import contribute from "./index.server.js";
import { inputSchema } from "./shared/input.js";
import type { ClaudeCredentialLookup } from "./server/usage.js";
import type { ReadSnapshots } from "./server/windows-credentials.js";
import {
  CLEARED,
  DAEMON_LOGIN,
  FRESH_INSTALL,
  NO_LOGIN,
  login,
  profileApi,
  providers,
  serviceFor,
  windowsHost,
} from "./test/windows-host.js";

const FIRST = "C:/fixture/provider-profiles/first";
const SECOND = "C:/fixture/provider-profiles/second";

/** Registers the plugin on this host and looks its usage sources up by id. */
function sourcesOn(lookup: ClaudeCredentialLookup, fetchApi: typeof fetch = profileApi) {
  const sources = new Map<string, UsageSourceRegistration>();
  contribute(
    {
      handle() {},
      registerUsageSource(source) {
        sources.set(source.id, source);
      },
    },
    { lookup, fetchApi },
  );
  return (id: string) => {
    const source = sources.get(id);
    if (!source) throw new Error(`Usage source ${id} was not registered`);
    return source;
  };
}

async function listedServices(source: UsageSourceRegistration) {
  const accounts = await source.discover({ kind: "global" });
  return accounts.map((account) => {
    const { route } = inputSchema.parse(account.input);
    return route.store === "windows-credman" ? route.service : route.store;
  });
}

it("neither Claude source lists the daemon's empty login that no provider uses", async () => {
  const source = sourcesOn(
    windowsHost(
      providers({
        claude: { env: { CLAUDE_CONFIG_DIR: FIRST } },
        second: { extends: "claude", env: { CLAUDE_CONFIG_DIR: SECOND } },
      }),
      {
        [DAEMON_LOGIN]: NO_LOGIN,
        [serviceFor(FIRST)]: login("isolated-first"),
        [serviceFor(SECOND)]: login("isolated-second"),
      },
    ),
  );
  const providerLogins = [serviceFor(FIRST), serviceFor(SECOND)];
  expect(await listedServices(source("claude"))).toEqual(providerLogins);
  expect(await listedServices(source("claude-windows"))).toEqual(providerLogins);
});

it("both Claude sources report the daemon's empty login on a fresh install", async () => {
  const source = sourcesOn(windowsHost(FRESH_INSTALL, { [DAEMON_LOGIN]: NO_LOGIN }));
  const daemonLogin = { route: { store: "windows-credman", service: DAEMON_LOGIN } };
  for (const id of ["claude", "claude-windows"]) {
    expect(await listedServices(source(id))).toEqual([DAEMON_LOGIN]);
    expect(await source(id).fetch(daemonLogin)).toEqual(CLEARED);
  }
});

it.each(["claude", "claude-windows"])(
  "a host discovery through both sources starts one PowerShell helper, and %s's fetches after it start none",
  async (fetcher) => {
    const { home, env, platform } = windowsHost(
      providers({
        claude: { env: { CLAUDE_CONFIG_DIR: FIRST } },
        second: { extends: "claude", env: { CLAUDE_CONFIG_DIR: SECOND } },
      }),
      {},
    );
    const held: Record<string, unknown> = {
      [DAEMON_LOGIN]: NO_LOGIN,
      [serviceFor(FIRST)]: login(`isolated-wired-first-${fetcher}`),
      [serviceFor(SECOND)]: login(`isolated-wired-second-${fetcher}`),
    };
    // The helper process itself, counted, and no login reader in its place: the plugin's own
    // wiring decides which reads share a process.
    const helpers: string[][] = [];
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const readWindowsSnapshots: ReadSnapshots = async (names) => {
      helpers.push(names);
      await answered;
      return names.map((name) => {
        const stored = held[name.slice(0, -"/claude-code-user".length)];
        const raw = stored === undefined ? null : JSON.stringify(stored);
        return { meta: null, raw, parts: null, after: null };
      });
    };
    const usage: string[] = [];
    const vendor: typeof fetch = async (url, init) => {
      const token = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
      if (String(url).endsWith("/profile"))
        return Response.json({ account: { uuid: token }, organization: { uuid: "org" } });
      usage.push(token);
      return Response.json({ five_hour: { utilization: 20, resets_at: "2026-11-13T12:00:00Z" } });
    };
    const source = sourcesOn({ home, env, platform, readWindowsSnapshots }, vendor);
    // Like a renewal of the cache group: both sources discover the host's logins together.
    const windowsDiscovery = source("claude-windows").discover({ kind: "global" });
    await vi.waitFor(() => expect(helpers).toHaveLength(1));
    const claudeDiscovery = source("claude").discover({ kind: "global" });
    answer();
    const [windowsAccounts, claudeAccounts] = await Promise.all([
      windowsDiscovery,
      claudeDiscovery,
    ]);
    expect(windowsAccounts).toEqual(claudeAccounts);
    expect(helpers).toEqual([
      [DAEMON_LOGIN, serviceFor(FIRST), serviceFor(SECOND)].map(
        (service) => service + "/claude-code-user",
      ),
    ]);
    // The registry then fetches each account once, through either source.
    for (const account of claudeAccounts)
      expect((await source(fetcher).fetch(account.input)).status).toBe("available");
    expect(usage).toEqual([`isolated-wired-first-${fetcher}`, `isolated-wired-second-${fetcher}`]);
    expect(helpers).toHaveLength(1);
  },
);
