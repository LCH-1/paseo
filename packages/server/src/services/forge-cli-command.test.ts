import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCachedCliPathResolver,
  createForgeCliRunner,
  ForgeAuthenticationError,
  ForgeCliMissingError,
  ForgeCommandError,
  forgeErrorLogFields,
  probeHostViaCliAuthStatus,
} from "./forge-cli-command.js";
import { isPlatform } from "../test-utils/platform.js";

describe.skipIf(isPlatform("win32"))("probeHostViaCliAuthStatus", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "forge-cli-command-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFakeCli(script: string): string {
    const cliPath = join(tempDir, "forge-cli");
    writeFileSync(cliPath, script);
    chmodSync(cliPath, 0o755);
    return cliPath;
  }

  it("recognizes a host when the CLI auth status succeeds", async () => {
    const cli = writeFakeCli(`#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--hostname" ] && [ "$4" = "git.acme.internal" ]; then
  exit 0
fi
exit 1
`);

    await expect(
      probeHostViaCliAuthStatus({
        cli,
        host: "git.acme.internal",
      }),
    ).resolves.toBe(true);
  });

  it("rejects a host when the CLI auth status fails", async () => {
    const cli = writeFakeCli(`#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
exit 1
`);

    await expect(
      probeHostViaCliAuthStatus({
        cli,
        host: "git.acme.internal",
      }),
    ).resolves.toBe(false);
  });

  it("rejects a host when the CLI is missing", async () => {
    await expect(
      probeHostViaCliAuthStatus({
        cli: join(tempDir, "missing-cli"),
        host: "git.acme.internal",
      }),
    ).resolves.toBe(false);
  });
});

describe.skipIf(isPlatform("win32"))("createForgeCliRunner", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "forge-cli-runner-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSlowCli(): string {
    const cliPath = join(tempDir, "slow-cli");
    writeFileSync(cliPath, "#!/bin/sh\nsleep 5\n");
    chmodSync(cliPath, 0o755);
    return cliPath;
  }

  class FakeCommandError extends Error {
    readonly stderr: string;
    constructor(params: { stderr: string }) {
      super("command failed");
      this.stderr = params.stderr;
    }
  }

  it("kills a hung CLI invocation after the configured timeout", async () => {
    const cli = writeSlowCli();
    const runner = createForgeCliRunner({
      binary: cli,
      envOverlay: {},
      timeoutMs: 100,
      isAuthFailureText: () => false,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is FakeCommandError => error instanceof FakeCommandError,
        createAuthError: (stderr) => new Error(`auth: ${stderr}`),
        createMissingError: () => new Error("missing"),
        createCommandError: (params) => new FakeCommandError(params),
      },
    });

    await expect(runner.run(["arg"], { cwd: tempDir })).rejects.toThrow();
  });

  it("classifies a timed-out invocation through normalizeError", async () => {
    const cli = writeSlowCli();
    const runner = createForgeCliRunner({
      binary: cli,
      envOverlay: {},
      timeoutMs: 100,
      isAuthFailureText: () => false,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is FakeCommandError => error instanceof FakeCommandError,
        createAuthError: (stderr) => new Error(`auth: ${stderr}`),
        createMissingError: () => new Error("missing"),
        createCommandError: (params) => new FakeCommandError(params),
      },
    });

    const rawError = await runner.run(["arg"], { cwd: tempDir }).catch((error: unknown) => error);
    const normalized = runner.normalizeError(rawError, { args: ["arg"], cwd: tempDir });
    expect(normalized).toBeInstanceOf(FakeCommandError);
    expect((normalized as FakeCommandError).stderr).toMatch(/timed out after 100ms/);
  });
});

describe("createForgeCliRunner argument delivery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "forge-cli-argv-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // The bare binary name "node" is what a Windows launch routes through
  // cmd.exe, which cuts the command line at the first newline inside an
  // argument. The resolved path must bypass that.
  it("delivers multi-line, quoted and percent arguments verbatim to the resolved executable", async () => {
    const scriptPath = join(tempDir, "echo-argv.js");
    writeFileSync(scriptPath, "process.stdout.write(JSON.stringify(process.argv.slice(3)));\n");
    const runner = createForgeCliRunner({
      binary: "node",
      envOverlay: {},
      timeoutMs: 10_000,
      isAuthFailureText: () => false,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is ForgeCommandError => error instanceof ForgeCommandError,
        createAuthError: (stderr) => new Error(`auth: ${stderr}`),
        createMissingError: () => new Error("missing"),
        createCommandError: (params) =>
          new ForgeCommandError({ brand: "Node", binary: "node" }, params),
      },
    });
    const args = [
      "api",
      "graphql",
      "-f",
      'query=query Batch {\n  t0: repository(owner: "acme", name: "repo") {\n    isFork\n  }\n}',
      "-f",
      'body=First line\r\n\r\nSecond "quoted" line at 100%',
      "--format=%(refname)%09%PATH%",
    ];

    const { stdout } = await runner.run([scriptPath, "--", ...args], {
      cwd: tempDir,
      executablePath: process.execPath,
    });

    expect(JSON.parse(stdout)).toEqual(args);
  });
});

describe("forgeErrorLogFields", () => {
  class FakeForgeCommandError extends ForgeCommandError {
    constructor(params: { args: string[]; exitCode: number; stderr: string; stdout?: string }) {
      super({ brand: "Fake", binary: "fake" }, { cwd: "/repo", ...params });
      this.name = "FakeForgeCommandError";
    }
  }

  it("reduces a CLI command error to one clamped single-line message plus stderr", () => {
    const query = `query Batch {\n${"  field\n".repeat(500)}}`;
    const error = new FakeForgeCommandError({
      args: ["api", "graphql", "-f", `query=${query}`],
      exitCode: 1,
      stderr: 'fake: Expected NAME, actual: (none) ("") at [1, 35]\n',
      stdout: '{"errors":[]}',
    });
    const flatMessage = `Fake CLI command failed: fake api graphql -f query=query Batch {${" field".repeat(500)} }`;

    expect(forgeErrorLogFields(error)).toEqual({
      error: {
        type: "FakeForgeCommandError",
        message: `${flatMessage.slice(0, 300)}…`,
        exitCode: 1,
        stderr: 'fake: Expected NAME, actual: (none) ("") at [1, 35]',
      },
    });
  });

  it("clamps a long stderr", () => {
    const error = new FakeForgeCommandError({
      args: ["pr", "view"],
      exitCode: 1,
      stderr: "x".repeat(2_000),
    });

    expect(forgeErrorLogFields(error)).toEqual({
      error: {
        type: "FakeForgeCommandError",
        message: "Fake CLI command failed: fake pr view",
        exitCode: 1,
        stderr: `${"x".repeat(500)}…`,
      },
    });
  });

  it("describes a missing CLI and a signed-out CLI without a stack", () => {
    expect(forgeErrorLogFields(new ForgeCliMissingError("fake is not installed"))).toEqual({
      error: { type: "Error", message: "fake is not installed" },
    });
    expect(
      forgeErrorLogFields(
        new ForgeAuthenticationError("Fake CLI authentication failed", {
          stderr: "run fake auth login\n",
        }),
      ),
    ).toEqual({
      error: {
        type: "Error",
        message: "Fake CLI authentication failed",
        stderr: "run fake auth login",
      },
    });
  });

  it("passes any other error through so its stack is still logged", () => {
    const error = new TypeError("status.checks is not iterable");

    expect(forgeErrorLogFields(error)).toEqual({ err: error });
  });
});

describe("createCachedCliPathResolver", () => {
  it("resolves once and reuses the cached path on later calls", async () => {
    let calls = 0;
    const resolveCliPath = createCachedCliPathResolver(async () => {
      calls += 1;
      return "/usr/bin/forge-cli";
    });

    await expect(resolveCliPath()).resolves.toBe("/usr/bin/forge-cli");
    await expect(resolveCliPath()).resolves.toBe("/usr/bin/forge-cli");
    expect(calls).toBe(1);
  });

  it("retries on the next call after a miss instead of caching null forever", async () => {
    let calls = 0;
    const resolveCliPath = createCachedCliPathResolver(async () => {
      calls += 1;
      return calls === 1 ? null : "/usr/bin/forge-cli";
    });

    await expect(resolveCliPath()).resolves.toBeNull();
    await expect(resolveCliPath()).resolves.toBe("/usr/bin/forge-cli");
    expect(calls).toBe(2);
  });

  it("coalesces concurrent callers onto a single in-flight resolution", async () => {
    let calls = 0;
    const resolveCliPath = createCachedCliPathResolver(async () => {
      calls += 1;
      return "/usr/bin/forge-cli";
    });

    await Promise.all([resolveCliPath(), resolveCliPath(), resolveCliPath()]);
    expect(calls).toBe(1);
  });
});
