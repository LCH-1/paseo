import { describe, expect, it, vi } from "vitest";
import { openDirectoryTerminal, runCreateTerminalWorkspace } from "./new-workspace-terminal";
import type { WorkspaceDescriptor } from "@/stores/session-store";

function createRecordingNavigate() {
  const recorded: Array<{ serverId: string; workspaceId: string; target: unknown }> = [];
  return {
    recorded,
    navigate: (serverId: string, workspaceId: string, target: unknown) => {
      recorded.push({ serverId, workspaceId, target });
    },
  };
}

describe("runCreateTerminalWorkspace", () => {
  it("creates the workspace without a chat agent, substitutes the prompt into the profile, and navigates to the terminal tab", async () => {
    const workspace = { id: "workspace-123", workspaceDirectory: "/repo/workspace-123" };
    const ensureWorkspace = vi.fn().mockResolvedValue(workspace);
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-1" });
    const sendTerminalInput = vi.fn();
    const { navigate, recorded } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "fix the bug",
      profile: { command: "claude", args: ["{{{prompt}}}"] },
      profileName: "Claude Code",
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    // Seeds the generated title and branch name without creating a chat agent.
    expect(ensureWorkspace).toHaveBeenCalledWith({
      cwd: "/repo",
      prompt: "fix the bug",
      attachments: [],
      withInitialAgent: false,
    });
    expect(createTerminal).toHaveBeenCalledWith({
      workspaceDirectory: "/repo/workspace-123",
      workspaceId: "workspace-123",
      name: "Claude Code",
      command: "claude",
      args: ["fix the bug"],
    });
    expect(recorded).toEqual([
      {
        serverId: "server-abc",
        workspaceId: "workspace-123",
        target: { kind: "terminal", terminalId: "term-1" },
      },
    ]);
  });

  it("drops a sentinel-only arg when the prompt is empty, so a bare command still launches", async () => {
    const workspace = { id: "ws-1", workspaceDirectory: "/repo/ws-1" };
    const ensureWorkspace = vi.fn().mockResolvedValue(workspace);
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-2" });
    const sendTerminalInput = vi.fn();
    const { navigate } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "",
      profile: { command: "claude", args: ["{{{prompt}}}"] },
      profileName: "Claude Code",
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    expect(createTerminal).toHaveBeenCalledWith({
      workspaceDirectory: "/repo/ws-1",
      workspaceId: "ws-1",
      name: "Claude Code",
      command: "claude",
      args: [],
    });
  });

  it("does not seed workspace naming from a hidden draft for a launch-only profile", async () => {
    const workspace = { id: "ws-1", workspaceDirectory: "/repo/ws-1" };
    const ensureWorkspace = vi.fn().mockResolvedValue(workspace);
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-2" });
    const sendTerminalInput = vi.fn();
    const { navigate } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "hidden draft from the previous profile",
      profile: { command: "npm", args: ["run", "dev"] },
      profileName: "Dev server",
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    expect(ensureWorkspace).toHaveBeenCalledWith({
      cwd: "/repo",
      prompt: "",
      attachments: [],
      withInitialAgent: false,
    });
    expect(createTerminal).toHaveBeenCalledWith({
      workspaceDirectory: "/repo/ws-1",
      workspaceId: "ws-1",
      name: "Dev server",
      command: "npm",
      args: ["run", "dev"],
    });
  });

  it("does not type into the terminal when a profile took the prompt as argv", async () => {
    const ensureWorkspace = vi
      .fn()
      .mockResolvedValue({ id: "ws-9", workspaceDirectory: "/repo/ws-9" });
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-9" });
    const sendTerminalInput = vi.fn();
    const { navigate } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "fix the bug",
      profile: { command: "claude", args: ["{{{prompt}}}"] },
      profileName: "Claude Code",
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    expect(sendTerminalInput).not.toHaveBeenCalled();
  });

  it("seeds workspace naming from a blank terminal's command too", async () => {
    const ensureWorkspace = vi
      .fn()
      .mockResolvedValue({ id: "ws-7", workspaceDirectory: "/repo/ws-7" });
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-7" });
    const sendTerminalInput = vi.fn();
    const { navigate } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "npm run dev",
      profile: null,
      profileName: undefined,
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    expect(ensureWorkspace).toHaveBeenCalledWith({
      cwd: "/repo",
      prompt: "npm run dev",
      attachments: [],
      withInitialAgent: false,
    });
  });

  it("types the command into the shell, with a carriage return, for a blank terminal", async () => {
    const ensureWorkspace = vi
      .fn()
      .mockResolvedValue({ id: "ws-5", workspaceDirectory: "/repo/ws-5" });
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-5" });
    const sendTerminalInput = vi.fn();
    const { navigate } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "  npm run dev  ",
      profile: null,
      profileName: undefined,
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    // The shell parses it, so it is typed rather than turned into argv.
    expect(createTerminal).toHaveBeenCalledWith({
      workspaceDirectory: "/repo/ws-5",
      workspaceId: "ws-5",
      name: undefined,
    });
    expect(sendTerminalInput).toHaveBeenCalledWith("term-5", "npm run dev\r");
  });

  it("launches a blank terminal without typing anything when no command was entered", async () => {
    const ensureWorkspace = vi
      .fn()
      .mockResolvedValue({ id: "ws-6", workspaceDirectory: "/repo/ws-6" });
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-6" });
    const sendTerminalInput = vi.fn();
    const { navigate } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "   ",
      profile: null,
      profileName: undefined,
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    expect(sendTerminalInput).not.toHaveBeenCalled();
  });

  it("launches the default shell with no command/args and no name when profile is null", async () => {
    const workspace = { id: "ws-1", workspaceDirectory: "/repo/ws-1" };
    const ensureWorkspace = vi.fn().mockResolvedValue(workspace);
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-3" });
    const sendTerminalInput = vi.fn();
    const { navigate } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "ls -la",
      profile: null,
      profileName: undefined,
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    expect(createTerminal).toHaveBeenCalledWith({
      workspaceDirectory: "/repo/ws-1",
      workspaceId: "ws-1",
      name: undefined,
    });
  });
});

function directoryWorkspace(overrides: Partial<WorkspaceDescriptor> = {}): WorkspaceDescriptor {
  return {
    id: "workspace-main",
    projectId: "project-a",
    projectDisplayName: "Project A",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    ...overrides,
  };
}

function directoryTerminalInput(workspaces: WorkspaceDescriptor[] = []) {
  const workspace = directoryWorkspace();
  return {
    serverId: "remote-host",
    directory: "/repo",
    workspaces,
    client: {
      createWorkspace: vi.fn().mockResolvedValue({ workspace, error: null }),
      createTerminal: vi.fn().mockResolvedValue({ terminal: { id: "terminal-new" }, error: null }),
    },
    acceptWorkspace: vi.fn(),
    onTerminalCreated: vi.fn(),
    navigate: vi.fn(),
  };
}

describe("openDirectoryTerminal", () => {
  it("opens the project's directory rather than a worktree or the active workspace", async () => {
    const main = directoryWorkspace();
    const input = directoryTerminalInput([
      directoryWorkspace({ id: "worktree", workspaceDirectory: "/repo/.worktrees/topic" }),
      main,
    ]);
    await openDirectoryTerminal({ ...input, projectId: "project-a" });
    expect(input.client.createWorkspace).not.toHaveBeenCalled();
    expect(input.client.createTerminal).toHaveBeenCalledWith("/repo", undefined, undefined, {
      workspaceId: "workspace-main",
    });
    expect(input.navigate).toHaveBeenCalledWith("remote-host", "workspace-main", {
      kind: "terminal",
      terminalId: "terminal-new",
    });
    expect(input.onTerminalCreated).toHaveBeenCalledWith(main, { id: "terminal-new" });
  });

  it("creates a directory workspace without an agent when the project has no workspace", async () => {
    const input = directoryTerminalInput();
    await openDirectoryTerminal({ ...input, projectId: "project-a" });
    expect(input.client.createWorkspace).toHaveBeenCalledWith({
      source: { kind: "directory", path: "/repo", projectId: "project-a" },
    });
    expect(input.acceptWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: "workspace-main" }),
    );
    expect(input.client.createTerminal).toHaveBeenCalledWith("/repo", undefined, undefined, {
      workspaceId: "workspace-main",
    });
  });

  it("uses root when the host path is unset", async () => {
    const input = directoryTerminalInput([directoryWorkspace({ workspaceDirectory: "/" })]);
    await openDirectoryTerminal({ ...input, directory: "  " });
    expect(input.client.createWorkspace).not.toHaveBeenCalled();
    expect(input.client.createTerminal).toHaveBeenCalledWith("/", undefined, undefined, {
      workspaceId: "workspace-main",
    });
  });

  it("opens the Windows drive root resolved by the host for /", async () => {
    const input = directoryTerminalInput();
    input.client.createWorkspace.mockResolvedValue({
      workspace: directoryWorkspace({ workspaceDirectory: "C:\\" }),
      error: null,
    });
    await openDirectoryTerminal({ ...input, directory: "/" });
    expect(input.client.createTerminal).toHaveBeenCalledWith("C:/", undefined, undefined, {
      workspaceId: "workspace-main",
    });
  });

  it("matches Windows separators and trailing slashes", async () => {
    const input = directoryTerminalInput([
      directoryWorkspace({ workspaceDirectory: "C:/projects/repo" }),
    ]);
    await openDirectoryTerminal({ ...input, directory: " C:\\projects\\repo\\ " });
    expect(input.client.createWorkspace).not.toHaveBeenCalled();
  });

  it("does not reuse an archiving workspace or one from another project", async () => {
    const input = directoryTerminalInput([
      directoryWorkspace({ archivingAt: "2026-10-27T00:00:00.000Z" }),
      directoryWorkspace({ projectId: "other-project" }),
    ]);
    await openDirectoryTerminal({ ...input, projectId: "project-a" });
    expect(input.client.createWorkspace).toHaveBeenCalledOnce();
  });

  it("surfaces workspace creation errors without starting a terminal or navigating", async () => {
    const input = directoryTerminalInput();
    input.client.createWorkspace.mockResolvedValue({
      workspace: null,
      error: "Directory does not exist",
    });
    await expect(openDirectoryTerminal(input)).rejects.toThrow("Directory does not exist");
    expect(input.client.createTerminal).not.toHaveBeenCalled();
    expect(input.navigate).not.toHaveBeenCalled();
  });

  it("surfaces terminal creation errors and keeps the current tab", async () => {
    const input = directoryTerminalInput([directoryWorkspace()]);
    input.client.createTerminal.mockResolvedValue({ terminal: null, error: "Shell failed" });
    await expect(openDirectoryTerminal(input)).rejects.toThrow("Shell failed");
    expect(input.onTerminalCreated).not.toHaveBeenCalled();
    expect(input.navigate).not.toHaveBeenCalled();
  });
});
