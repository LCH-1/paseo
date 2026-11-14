import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshCliTrampolines, retargetCliTrampoline } from "./refresh";

const trampoline = (shim: string) =>
  [
    "@echo off",
    `set "BUNDLED_CLI=${shim}"`,
    `if not exist "%BUNDLED_CLI%" (`,
    `  echo Paseo CLI not found at %BUNDLED_CLI% — is Paseo installed? 1>&2`,
    `  exit /b 1`,
    `)`,
    `call "%BUNDLED_CLI%" %*`,
    `exit /b %errorlevel%`,
  ].join("\r\n");

const tuiWrapper = [
  "@echo off",
  "setlocal",
  "rem PASEO_TUI_COMMAND_V1",
  'if /I "%~1"=="tui" goto paseo_tui',
  'call "%~dp0paseo-without-tui.cmd" %*',
  "exit /b %errorlevel%",
].join("\r\n");

describe("retargetCliTrampoline", () => {
  it("points a stale trampoline at the running install and keeps the other lines", () => {
    const next = retargetCliTrampoline(
      trampoline("C:\\Program Files\\Paseo\\resources\\bin\\paseo.cmd"),
      "C:\\Paseo\\1.0.13\\resources\\bin\\paseo.cmd",
    );
    expect(next).toBe(trampoline("C:\\Paseo\\1.0.13\\resources\\bin\\paseo.cmd"));
  });

  it("leaves a trampoline that already points at the install, ignoring case", () => {
    const current = "C:\\Paseo\\1.0.13\\resources\\bin\\paseo.cmd";
    expect(retargetCliTrampoline(trampoline(current), current.toLowerCase())).toBeNull();
  });

  it("does not treat other command files as trampolines", () => {
    expect(retargetCliTrampoline(tuiWrapper, "C:\\Paseo\\paseo.cmd")).toBeNull();
    expect(
      retargetCliTrampoline('@echo off\r\nset "BUNDLED_CLI=C:\\x.cmd"\r\n', "C:\\y.cmd"),
    ).toBeNull();
  });

  it("keeps dollar signs in the install path literal", () => {
    const shim = "C:\\Users\\a$&b\\Paseo\\resources\\bin\\paseo.cmd";
    expect(retargetCliTrampoline(trampoline("C:\\old.cmd"), shim)).toBe(trampoline(shim));
  });
});

describe("refreshCliTrampolines", () => {
  let root: string;
  let binDir: string;
  let shim: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-cli-refresh-"));
    binDir = path.join(root, "bin");
    shim = path.join(root, "1.0.13", "resources", "bin", "paseo.cmd");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(path.dirname(shim), { recursive: true });
    await fs.writeFile(shim, "@echo off\r\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rewrites the trampoline a wrapper renamed and leaves the wrapper alone", async () => {
    await fs.writeFile(path.join(binDir, "paseo.cmd"), tuiWrapper);
    await fs.writeFile(
      path.join(binDir, "paseo-without-tui.cmd"),
      trampoline("C:\\Program Files\\Paseo\\resources\\bin\\paseo.cmd"),
    );

    const rewritten = await refreshCliTrampolines({ binDir, shimPath: shim });

    expect(rewritten).toEqual([path.join(binDir, "paseo-without-tui.cmd")]);
    expect(await fs.readFile(path.join(binDir, "paseo-without-tui.cmd"), "utf-8")).toBe(
      trampoline(shim),
    );
    expect(await fs.readFile(path.join(binDir, "paseo.cmd"), "utf-8")).toBe(tuiWrapper);
    expect((await fs.readdir(binDir)).sort()).toEqual(["paseo-without-tui.cmd", "paseo.cmd"]);
  });

  it("changes nothing when the running install has no shim", async () => {
    await fs.rm(shim);
    const stale = trampoline("C:\\Program Files\\Paseo\\resources\\bin\\paseo.cmd");
    await fs.writeFile(path.join(binDir, "paseo.cmd"), stale);

    expect(await refreshCliTrampolines({ binDir, shimPath: shim })).toEqual([]);
    expect(await fs.readFile(path.join(binDir, "paseo.cmd"), "utf-8")).toBe(stale);
  });

  it("returns nothing when the bin folder does not exist", async () => {
    await fs.rm(binDir, { recursive: true });
    expect(await refreshCliTrampolines({ binDir, shimPath: shim })).toEqual([]);
  });
});
