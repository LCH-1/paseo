import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export async function compatibilityEnabled() {
  const rawHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  let home = resolve(rawHome);
  if (rawHome === "~") home = homedir();
  else if (rawHome.startsWith("~/")) home = join(homedir(), rawHome.slice(2));
  let raw: string;
  try {
    raw = await readFile(
      join(home, "plugin-settings", "claude-windows-usage", "native.json"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let config;
    try {
      config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw failure;
    }
    const legacy = config.plugins?.["claude-windows-usage"];
    return legacy ? config.pluginsEnabled === true && legacy.enabled !== false : true;
  }
  const value = JSON.parse(raw);
  if (value.version !== 1 || typeof value.values?.enabled !== "boolean")
    throw new Error("Invalid Windows usage compatibility setting");
  return value.values.enabled;
}
