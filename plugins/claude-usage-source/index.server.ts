import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { accessProfileSchema, discover, fetchUsage, profilesForProviders } from "./server/usage.js";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { compatibilityEnabled } from "./server/enabled.js";
import { selectWindowsAccounts } from "./server/windows-accounts.js";
import { configuredClaudeProviders } from "./server/claude-provider-config.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { hashAccountKey, type UsageScope } from "@getpaseo/plugin/server/usage";

export default function contribute(server: PluginServerContext) {
  server.handle(
    defineRpc({
      name: "claude.profiles.read.request",
      input: z.object({ providerIds: z.array(z.string().min(1).max(200)).max(100) }),
      output: z.object({
        version: z.literal(1),
        profiles: z.array(
          z.union([
            z.object({
              providerId: z.string(),
              status: z.literal("ready"),
              profile: accessProfileSchema,
              identity: z.string(),
            }),
            z.object({
              providerId: z.string(),
              status: z.union([z.number(), z.enum(["missing", "unknown"])]),
            }),
          ]),
        ),
      }),
    }),
    async ({ providerIds }) => ({
      version: 1 as const,
      profiles: await profilesForProviders(providerIds),
    }),
  );
  const pending = new Map<string, ReturnType<typeof discover>>();
  const sharedDiscover = (scope: UsageScope) => {
    const key = hashAccountKey(JSON.stringify(scope));
    const existing = pending.get(key);
    if (existing) return existing;
    const request = discover(scope).finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });
    pending.set(key, request);
    return request;
  };
  server.registerUsageSource({
    id: "claude",
    cacheGroup: "claude",
    label: "Claude",
    icon: "icon.svg",
    input: inputSchema,
    discover: sharedDiscover,
    fetch: fetchUsage,
  });
  // COMPAT(windowsUsageIdentity): preserve existing cards and pinning. The engine,
  // credential reads, profile cache and fetch cache are shared with `claude`.
  server.registerUsageSource({
    id: "claude-windows",
    cacheGroup: "claude",
    label: "Claude",
    icon: "icon.svg",
    input: inputSchema,
    discover: async (scope) => {
      if (process.platform !== "win32" || !(await compatibilityEnabled())) return [];
      const [accounts, providers] = await Promise.all([
        sharedDiscover(scope),
        configuredClaudeProviders(),
      ]);
      return selectWindowsAccounts(
        accounts,
        providers.map((provider) => provider.env.CLAUDE_CONFIG_DIR ?? ""),
        process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      );
    },
    fetch: async (input) => {
      if (!(await compatibilityEnabled())) throw Error("Windows usage compatibility is disabled");
      return fetchUsage(inputSchema.parse(input));
    },
  });
  return () => {};
}
