import { promises as fs } from "node:fs";
import path from "node:path";

const BUNDLED_CLI_LINE = /^set "BUNDLED_CLI=([^"\r\n]*)"(\r?)$/m;
const DELEGATES_TO_BUNDLED_CLI = /^call "%BUNDLED_CLI%" %\*\r?$/m;

/**
 * Returns the trampoline text pointed at `shimPath`, or null when `content` is not a Paseo CLI
 * trampoline written by installCli or already points there.
 */
export function retargetCliTrampoline(content: string, shimPath: string): string | null {
  const match = BUNDLED_CLI_LINE.exec(content);
  if (!match || !DELEGATES_TO_BUNDLED_CLI.test(content)) return null;
  if (match[1].toLowerCase() === shimPath.toLowerCase()) return null;
  return content.replace(BUNDLED_CLI_LINE, () => `set "BUNDLED_CLI=${shimPath}"${match[2]}`);
}

/**
 * Windows trampolines bake the install folder in, and every Suite install lives in its own
 * versioned folder, so an installed `paseo` command breaks after each update. Rewrites every
 * trampoline in `binDir` (including ones a wrapper renamed, such as paseo-without-tui.cmd) to
 * the running install's shim. Other .cmd files are left alone. Returns the rewritten paths.
 */
export async function refreshCliTrampolines(input: {
  binDir: string;
  shimPath: string;
}): Promise<string[]> {
  if (!(await fs.stat(input.shimPath).catch(() => null))?.isFile()) return [];
  const names = await fs.readdir(input.binDir).catch(() => [] as string[]);
  const rewritten: string[] = [];
  for (const name of names) {
    if (path.extname(name).toLowerCase() !== ".cmd") continue;
    const file = path.join(input.binDir, name);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.size > 64 * 1024) continue;
    const next = retargetCliTrampoline(await fs.readFile(file, "utf-8"), input.shimPath);
    if (next === null) continue;
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, next, "utf-8");
    await fs.rename(temporary, file);
    rewritten.push(file);
  }
  return rewritten;
}
