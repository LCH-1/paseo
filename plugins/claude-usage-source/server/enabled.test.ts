import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { compatibilityEnabled } from "./enabled.js";

test("promotion retains a disabled legacy source and its native replacement flag", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-windows-usage-flag-"));
  vi.stubEnv("PASEO_HOME", home);
  try {
    expect(await compatibilityEnabled()).toBe(true);
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        pluginsEnabled: true,
        plugins: { "claude-windows-usage": { enabled: false } },
      }),
    );
    expect(await compatibilityEnabled()).toBe(false);
    const file = path.join(home, "plugin-settings/claude-windows-usage/native.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, values: { enabled: true } }));
    expect(await compatibilityEnabled()).toBe(true);
    await writeFile(file, JSON.stringify({ version: 1, values: { enabled: false } }));
    expect(await compatibilityEnabled()).toBe(false);
    await writeFile(file, JSON.stringify({ version: 1, values: {} }));
    await expect(compatibilityEnabled()).rejects.toThrow("setting");
  } finally {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
