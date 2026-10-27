import { normalizeWorkspaceDescriptor, type WorkspaceDescriptor } from "@/stores/session-store";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import {
  profileTakesPrompt,
  substitutePrompt,
  type SubstitutableCommand,
} from "@getpaseo/protocol/terminal-profiles";

export interface CreatedTerminal {
  terminalId: string;
}

export interface CreateTerminalWorkspaceInput {
  cwd: string;
  prompt: string;
  /** The selected profile's command/args, or null for the default shell. */
  profile: SubstitutableCommand | null;
  /** Terminal tab name: the profile's display name, or undefined for shell. */
  profileName: string | undefined;
  ensureWorkspace: (input: {
    cwd: string;
    prompt: string;
    attachments: AgentAttachment[];
    withInitialAgent: boolean;
  }) => Promise<ReturnType<typeof normalizeWorkspaceDescriptor>>;
  createTerminal: (input: {
    workspaceDirectory: string;
    workspaceId: string;
    name?: string;
    command?: string;
    args?: string[];
  }) => Promise<CreatedTerminal>;
  /** Types text into a live terminal. Used for the shell path, where the typed command is a command, not argv. */
  sendTerminalInput: (terminalId: string, data: string) => void;
  serverId: string;
  navigate: (serverId: string, workspaceId: string, target: WorkspaceTabTarget) => void;
}

export async function runCreateTerminalWorkspace(
  input: CreateTerminalWorkspaceInput,
): Promise<void> {
  const {
    cwd,
    prompt,
    profile,
    profileName,
    ensureWorkspace,
    createTerminal,
    sendTerminalInput,
    serverId,
    navigate,
  } = input;
  // Seeds the generated workspace title and branch name. `withInitialAgent`
  // stays false, so this hands the daemon something to name the workspace after
  // without creating a chat agent. Worth passing even for a blank terminal,
  // where the text is a command: a branch called `npm-run-dev` beats a random
  // slug.
  const namingPrompt = profile && !profileTakesPrompt(profile) ? "" : prompt;
  const ensuredWorkspace = await ensureWorkspace({
    cwd,
    prompt: namingPrompt,
    attachments: [],
    withInitialAgent: false,
  });
  const resolved = profile ? substitutePrompt(profile, prompt) : null;
  const createdTerminal = await createTerminal({
    workspaceDirectory: ensuredWorkspace.workspaceDirectory,
    workspaceId: ensuredWorkspace.id,
    name: profileName,
    ...(resolved ? { command: resolved.command, args: resolved.args } : {}),
  });

  // A profile's prompt is argv, substituted into command/args above. A blank
  // terminal has no argv to substitute into, so the typed text is a command and
  // has to reach the shell the way any command does: typed at its prompt. That
  // also means the user's own shell parses it, which is the only thing that
  // gets quoting, pipes, and globs right on every platform.
  const trimmedPrompt = prompt.trim();
  if (!profile && trimmedPrompt) {
    sendTerminalInput(createdTerminal.terminalId, `${trimmedPrompt}\r`);
  }

  navigate(serverId, ensuredWorkspace.id, {
    kind: "terminal",
    terminalId: createdTerminal.terminalId,
  });
}

interface OpenDirectoryTerminalInput {
  serverId: string;
  directory: string;
  title: string;
  projectId?: string;
  client: Pick<DaemonClient, "createWorkspace" | "createTerminal">;
  acceptWorkspace: (workspace: WorkspaceDescriptor) => void;
  onTerminalCreated: (
    workspace: WorkspaceDescriptor,
    terminal: NonNullable<Awaited<ReturnType<DaemonClient["createTerminal"]>>["terminal"]>,
  ) => void;
  navigate: CreateTerminalWorkspaceInput["navigate"];
}

export async function openDirectoryTerminal(input: OpenDirectoryTerminalInput): Promise<void> {
  const directory = input.directory.trim() || "~";
  const result = await input.client.createWorkspace({
    source: { kind: "directory", path: directory, projectId: input.projectId },
    title: input.title,
  });
  if (!result.workspace) throw new Error(result.error ?? "Unable to open workspace");
  const workspace = normalizeWorkspaceDescriptor(result.workspace);
  input.acceptWorkspace(workspace);
  const created = await input.client.createTerminal(
    workspace.workspaceDirectory,
    undefined,
    undefined,
    {
      workspaceId: workspace.id,
    },
  );
  if (!created.terminal) throw new Error(created.error ?? "Unable to open terminal");
  input.onTerminalCreated(workspace, created.terminal);
  input.navigate(input.serverId, workspace.id, {
    kind: "terminal",
    terminalId: created.terminal.id,
  });
}
