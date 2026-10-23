import type { PluginAgentTabTitleContext, PluginAgentTabTitleResult } from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "../types";
import type { WorkspaceTitleSource } from "@/hooks/use-settings";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { resolveSidebarWorkspacePrimaryLabel } from "@/components/sidebar/sidebar-workspace-title";
import type { PanelDescriptor } from "@/panels/panel-registry";

type TitleInstallation = Pick<
  InstalledPlugin,
  "id" | "serverId" | "lifetime" | "agentTabTitleResolvers"
>;

interface TitleSession {
  agents: ReadonlyMap<string, Pick<Agent, "workspaceId">>;
  agentDetails: ReadonlyMap<string, Pick<Agent, "workspaceId">>;
  workspaces: Map<string, WorkspaceDescriptor>;
}

type TitleContext = Omit<PluginAgentTabTitleContext, "sidebarLabel" | "projectLabel">;

export function applyAgentTabTitle(
  descriptor: PanelDescriptor,
  replacement: PluginAgentTabTitleResult,
): PanelDescriptor {
  if (replacement === null) return descriptor;
  const titleLines = typeof replacement === "string" ? undefined : replacement;
  const label = typeof replacement === "string"
    ? replacement
    : `${replacement.primaryLabel}-${replacement.secondaryLabel}`;
  return { ...descriptor, label, tooltip: label, titleLines, titleState: "ready" };
}

function selectAgentTabWorkspace(input: {
  session: TitleSession | undefined;
  context: TitleContext;
}): WorkspaceDescriptor | null {
  const { session, context } = input;
  if (!session) return null;
  const agent = session.agents.get(context.agentId) ?? session.agentDetails.get(context.agentId);
  if (agent?.workspaceId !== context.workspaceId) return null;
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces: session.workspaces,
    workspaceId: context.workspaceId,
  });
  if (workspaceKey === null) return null;
  const workspace = session.workspaces.get(workspaceKey);
  if (!workspace || workspace.id !== context.workspaceId) return null;
  return workspace;
}

export function selectAgentTabProjectLabel(input: {
  session: TitleSession | undefined;
  context: TitleContext;
}): string | null {
  const workspace = selectAgentTabWorkspace(input);
  return workspace?.projectCustomName ?? workspace?.projectDisplayName ?? null;
}

export function selectAgentTabSidebarLabel(input: {
  session: TitleSession | undefined;
  context: TitleContext;
  workspaceTitleSource: WorkspaceTitleSource;
}): string | null {
  const workspace = selectAgentTabWorkspace(input);
  if (workspace === null) return null;
  return resolveSidebarWorkspacePrimaryLabel({
    workspace: {
      name: workspace.name,
      currentBranch: workspace.gitRuntime?.currentBranch ?? null,
    },
    workspaceTitleSource: input.workspaceTitleSource,
  });
}

function compareId(left: { id: string }, right: { id: string }): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export function resolveAgentTabTitle(
  installations: readonly TitleInstallation[],
  context: PluginAgentTabTitleContext,
): PluginAgentTabTitleResult {
  const owned = installations.filter(
    (installation) =>
      installation.serverId === context.serverId && !installation.lifetime.signal.aborted,
  );
  owned.sort(compareId);
  for (const installation of owned) {
    const resolvers = [...installation.agentTabTitleResolvers].sort(compareId);
    for (const resolver of resolvers) {
      try {
        const label: unknown = resolver.resolve(Object.freeze({ ...context }));
        if (typeof label === "string" && label.length > 0) return label;
        const isThenable =
          label !== null &&
          typeof label === "object" &&
          typeof Reflect.get(label, "then") === "function";
        if (isThenable) {
          void Promise.resolve(label).catch((error: unknown) =>
            console.warn(
              `[Plugins] Agent tab title resolver must be synchronous: ${installation.serverId}/${installation.id}/${resolver.id}`,
              error,
            ),
          );
          continue;
        }
        if (label !== null && typeof label === "object") {
          const primaryLabel: unknown = Reflect.get(label, "primaryLabel");
          const secondaryLabel: unknown = Reflect.get(label, "secondaryLabel");
          if (
            typeof primaryLabel === "string" && primaryLabel.length > 0 &&
            typeof secondaryLabel === "string" && secondaryLabel.length > 0
          ) {
            return { primaryLabel, secondaryLabel };
          }
        }
      } catch (error) {
        console.warn(
          `[Plugins] Agent tab title resolver failed: ${installation.serverId}/${installation.id}/${resolver.id}`,
          error,
        );
      }
    }
  }
  return null;
}
