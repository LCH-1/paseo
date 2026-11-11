import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface ProviderConfig {
  extends?: string;
  enabled?: boolean;
  env?: Record<string, string>;
}

interface ClaudeProvider {
  id: string;
  env: Record<string, string>;
}

interface ClaudeProviders {
  /** Enabled providers the config derives from `claude`, each with its merged environment. */
  configured: ClaudeProvider[];
  /**
   * The config has no `claude` entry. The built-in provider needs none: it is then enabled and
   * runs with the daemon's own environment.
   */
  builtinUnconfigured: boolean;
}

export async function claudeProviders(
  lookup: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ClaudeProviders> {
  const env = lookup.env ?? process.env;
  const home = lookup.home ?? homedir();
  const directory = env.PASEO_HOME || join(home, ".paseo");
  let raw: string;
  try {
    raw = await readFile(join(directory, "config.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { configured: [], builtinUnconfigured: true };
    throw error;
  }
  const config = JSON.parse(raw) as { agents?: { providers?: Record<string, ProviderConfig> } };
  const providers = config.agents?.providers ?? {};
  const configured: ClaudeProvider[] = [];
  for (const [id, provider] of Object.entries(providers)) {
    if (provider.enabled === false) continue;
    const seen = new Set<string>();
    const chain: ProviderConfig[] = [];
    let current: string | undefined = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      const entry: ProviderConfig | undefined = providers[current];
      if (entry) chain.push(entry);
      if (current === "claude") {
        configured.push({
          id,
          env: Object.assign({}, ...chain.toReversed().map((item) => item.env ?? {})),
        });
        break;
      }
      current = entry?.extends;
    }
  }
  return { configured, builtinUnconfigured: !providers.claude };
}

export async function configuredClaudeProviders(
  lookup: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ClaudeProvider[]> {
  return (await claudeProviders(lookup)).configured;
}
