import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWindowsCredentials } from "./windows-credentials.js";
import { discover, fetchUsage, resolveClaudeCredentials } from "./usage.js";
import { hashAccountKey } from "@getpaseo/plugin/server/usage";

describe("Claude Windows credentials", () => {
  it("reads legacy and split records without writing", async () => {
    const value = { claudeAiOauth: { accessToken: "fixture-only" } };
    expect(
      await readWindowsCredentials("fixture", async (name) =>
        name.endsWith("#m") ? null : JSON.stringify(value),
      ),
    ).toEqual(value);
    const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
    const chunks = [encoded.slice(0, 20), encoded.slice(20)];
    expect(
      await readWindowsCredentials("fixture", async (name) =>
        name.endsWith("#m")
          ? JSON.stringify({ n: 2, l: encoded.length })
          : chunks[Number(name.at(-1))],
      ),
    ).toEqual(value);
    await expect(
      readWindowsCredentials("fixture", async (name) =>
        name.endsWith("#m") ? JSON.stringify({ n: 2, l: encoded.length }) : null,
      ),
    ).rejects.toThrow("Incomplete");
  });
  it("rejects invalid split metadata and returns null for missing credentials", async () => {
    expect(await readWindowsCredentials("fixture", async () => null)).toBeNull();
    for (const n of [0, -1, 257, 1.5])
      await expect(
        readWindowsCredentials("fixture", async () => JSON.stringify({ n, l: 1 })),
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
});
