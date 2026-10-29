import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { discover, fetchUsage } from "./server/usage.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { configuredClaudeProviders } from "./server/claude-provider-config.js";
import { selectWindowsAccounts } from "./server/windows-accounts.js";
import { compatibilityEnabled } from "./server/enabled.js";
export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "claude-windows",
    label: "Claude",
    icon: "icon.svg",
    input: inputSchema,
    discover: async (scope) => {
      if (process.platform !== "win32") return [];
      if (!(await compatibilityEnabled())) return [];
      const [accounts, providers] = await Promise.all([
        discover(scope),
        configuredClaudeProviders(),
      ]);
      return selectWindowsAccounts(
        accounts,
        providers.map((provider) => provider.env.CLAUDE_CONFIG_DIR ?? ""),
        process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      );
    },
    fetch: async (...args) => {
      if (!(await compatibilityEnabled()))
        throw new Error("Windows usage compatibility is disabled");
      return fetchUsage(...args);
    },
  });
  return () => {};
}
