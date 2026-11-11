import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashAccountKey, type UsageSourceRegistration } from "@getpaseo/plugin/server/usage";
import contribute from "./index.server.js";
import { inputSchema } from "./shared/input.js";
import { readWindowsCredentials } from "./server/windows-credentials.js";

// The sources take no injected store: the fixture stands in for the PowerShell credential read.
vi.mock("./server/windows-credentials.js", () => ({ readWindowsCredentials: vi.fn() }));

const DAEMON_LOGIN = "Claude Code-credentials";
const FIRST = "C:/fixture/provider-profiles/first";
const SECOND = "C:/fixture/provider-profiles/second";
// What the CLI keeps next to a login, and all that is left once the login itself is gone.
const NO_LOGIN = { mcpOAuth: { "fixture-server": { accessToken: "isolated-mcp-token" } } };
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claude-usage-sources-"));
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("PASEO_HOME", join(home, ".paseo"));
  for (const inherited of [
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CLAUDE_CODE_FORCE_WINDOWS_CREDMAN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "ANTHROPIC_BASE_URL",
    "PI_CODING_AGENT_DIR",
    "PI_CONFIG_DIR",
    "PI_PROFILE",
    "OMP_PROFILE",
    "XDG_DATA_HOME",
  ])
    vi.stubEnv(inherited, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
  rmSync(home, { recursive: true, force: true });
});

function serviceFor(configDir: string) {
  return `${DAEMON_LOGIN}-${hashAccountKey(configDir.normalize("NFC")).slice(0, 8)}`;
}

function login(accessToken: string) {
  return { claudeAiOauth: { accessToken, expiresAt: Date.now() + 600_000 } };
}

/** Registers the plugin on a Windows host with these configured providers and credential services. */
function sourcesOn(providers: Record<string, unknown>, store: Record<string, unknown>) {
  mkdirSync(join(home, ".paseo"));
  writeFileSync(join(home, ".paseo", "config.json"), JSON.stringify({ agents: { providers } }));
  vi.mocked(readWindowsCredentials).mockImplementation(async (service) => store[service] ?? null);
  vi.stubGlobal("fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    const token = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "");
    return Response.json({ account: { uuid: token }, organization: { uuid: "org" } });
  });
  const sources = new Map<string, UsageSourceRegistration>();
  contribute({
    handle() {},
    registerUsageSource(source) {
      sources.set(source.id, source);
    },
  });
  return sources;
}

async function listedServices(source: UsageSourceRegistration | undefined) {
  if (!source) throw new Error("Usage source was not registered");
  const accounts = await source.discover({ kind: "global" });
  return accounts.map((account) => {
    const { route } = inputSchema.parse(account.input);
    return route.store === "windows-credman" ? route.service : route.store;
  });
}

it("neither Claude source lists the daemon's empty login that no provider uses", async () => {
  const sources = sourcesOn(
    {
      claude: { env: { CLAUDE_CONFIG_DIR: FIRST } },
      second: { extends: "claude", env: { CLAUDE_CONFIG_DIR: SECOND } },
    },
    {
      [DAEMON_LOGIN]: NO_LOGIN,
      [serviceFor(FIRST)]: login("isolated-first"),
      [serviceFor(SECOND)]: login("isolated-second"),
    },
  );
  const providerLogins = [serviceFor(FIRST), serviceFor(SECOND)];
  expect(await listedServices(sources.get("claude"))).toEqual(providerLogins);
  expect(await listedServices(sources.get("claude-windows"))).toEqual(providerLogins);
});

it("both Claude sources report the daemon's empty login while the built-in provider uses it", async () => {
  const sources = sourcesOn(
    { second: { extends: "claude", env: { CLAUDE_CONFIG_DIR: SECOND } } },
    { [DAEMON_LOGIN]: NO_LOGIN, [serviceFor(SECOND)]: login("isolated-second") },
  );
  const withDaemonLogin = [DAEMON_LOGIN, serviceFor(SECOND)];
  expect(await listedServices(sources.get("claude"))).toEqual(withDaemonLogin);
  expect(await listedServices(sources.get("claude-windows"))).toEqual(withDaemonLogin);
});
