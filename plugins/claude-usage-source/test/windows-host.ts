import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { hashAccountKey } from "@getpaseo/plugin/server/usage";

/** The daemon's own login: Claude Code's Windows credential service with no directory suffix. */
export const DAEMON_LOGIN = "Claude Code-credentials";
/** What the CLI keeps next to a login, and all that is left once the login itself is gone. */
export const NO_LOGIN = { mcpOAuth: { "fixture-server": { accessToken: "isolated-mcp-token" } } };
export const CLEARED = { status: "error", error: "Claude login store no longer exists" };
/** A login whose token the vendor answers with HTTP 401. */
export const REJECTED = "isolated-rejected";
/** A login whose owner cannot be looked up because the request fails. */
export const UNREACHABLE = "isolated-unreachable";

/** The credential service of a login kept under its own config directory. */
export function serviceFor(configDir: string): string {
  return `${DAEMON_LOGIN}-${hashAccountKey(configDir.normalize("NFC")).slice(0, 8)}`;
}

export function login(accessToken: string) {
  return { claudeAiOauth: { accessToken, expiresAt: Date.now() + 600_000 } };
}

/** The config file a daemon writes on first start: it has no provider entries at all. */
export const FRESH_INSTALL = {
  version: 1,
  daemon: {
    listen: "127.0.0.1:6767",
    cors: { allowedOrigins: ["https://app.paseo.sh"] },
    relay: { enabled: false },
  },
  app: { baseUrl: "https://app.paseo.sh" },
};

/** A Paseo config file holding these provider entries. */
export function providers(entries: Record<string, unknown>) {
  return { agents: { providers: entries } };
}

/**
 * A Windows host as a login lookup: its Paseo config file (none when null), what each credential
 * service holds (an Error is a read that fails), and the daemon's environment.
 */
export function windowsHost(
  config: object | null,
  store: Record<string, unknown>,
  env: Record<string, string> = {},
) {
  const home = mkdtempSync(join(tmpdir(), "claude-windows-host-"));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  if (config) {
    mkdirSync(join(home, ".paseo"));
    writeFileSync(join(home, ".paseo", "config.json"), JSON.stringify(config));
  }
  return {
    home,
    env: { USERPROFILE: home, ...env },
    platform: "win32" as const,
    readWindowsCredentials: async (service: string) => {
      const held = store[service];
      if (held instanceof Error) throw held;
      return held ?? null;
    },
  };
}

/** The vendor's profile endpoint: each fixture token is its own account, labelled by the token. */
export async function profileApi(_url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "");
  if (token === REJECTED) return new Response(null, { status: 401 });
  if (token === UNREACHABLE) throw new Error("Fixture profile lookup failed");
  return Response.json({
    account: { uuid: token, email: `${token}@example.test` },
    organization: { uuid: "org" },
  });
}
