import type { PluginAgentTabTitleContext } from "@getpaseo/plugin/client";
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

export function applyAgentTabTitle(
  descriptor: PanelDescriptor,
  replacement: string | null,
): PanelDescriptor {
  if (replacement === null) return descriptor;
  return { ...descriptor, label: replacement, tooltip: replacement, titleState: "ready" };
}

export function selectAgentTabSidebarLabel(input: {
  session: TitleSession | undefined;
  context: Omit<PluginAgentTabTitleContext, "sidebarLabel">;
  workspaceTitleSource: WorkspaceTitleSource;
}): string | null {
  const { session, context, workspaceTitleSource } = input;
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
  return resolveSidebarWorkspacePrimaryLabel({
    workspace: {
      name: workspace.name,
      currentBranch: workspace.gitRuntime?.currentBranch ?? null,
    },
    workspaceTitleSource,
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
): string | null {
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
