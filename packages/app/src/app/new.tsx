import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef } from "react";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import {
  ComposerEditingScope,
  WorkspaceComposerEditingSessionsProvider,
} from "@/composer/editing-session";
import { NewWorkspaceScreen } from "@/screens/new-workspace-screen";
import { buildNewWorkspaceDraftKey, generateDraftId } from "@/stores/draft-keys";
import { NewWorkspaceDraftScope } from "@/workspace-tabs/new-workspace-draft-state";
import {
  adoptLegacyNewWorkspaceDraft,
  useNewWorkspaceTabPresence,
} from "@/workspace-tabs/new-workspace-tabs";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";

/** New workspace drafts share one editing-session home, keyed like a tab by draft. */
const NEW_WORKSPACE_SESSIONS_KEY = "new-workspace";

export default function NewWorkspaceRoute() {
  const params = useLocalSearchParams<{
    serverId?: string;
    dir?: string;
    name?: string;
    projectId?: string;
    draftId?: string;
  }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const sourceDirectory = typeof params.dir === "string" ? params.dir : undefined;
  const displayName = typeof params.name === "string" ? params.name : undefined;
  const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
  const draftId = typeof params.draftId === "string" ? params.draftId : undefined;
  const generatedDraftId = useRef<string | null>(null);
  useEffect(() => {
    if (draftId?.trim()) return;
    generatedDraftId.current ??= generateDraftId();
    const nextDraftId = generatedDraftId.current;
    let cancelled = false;
    void adoptLegacyNewWorkspaceDraft(nextDraftId).then(() => {
      if (!cancelled) router.setParams({ draftId: nextDraftId });
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [draftId]);
  const screenKey = JSON.stringify([
    serverId,
    sourceDirectory ?? null,
    displayName ?? null,
    projectId ?? null,
    draftId ?? null,
  ]);

  // The shell remounts this route when the viewport crosses the compact breakpoint;
  // the draft's editing session (fullscreen, retained caret) lives above the shell.
  const draftKey = buildNewWorkspaceDraftKey(draftId);
  const sessionTabIds = useMemo(() => [draftKey], [draftKey]);

  if (!draftId?.trim()) return <HostRouteBootstrapBoundary>{null}</HostRouteBootstrapBoundary>;

  return (
    <HostRouteBootstrapBoundary>
      <NewWorkspaceDraftScope key={draftId} draftId={draftId}>
        <NewWorkspaceDraftPresence
          draftId={draftId}
          serverId={serverId}
          href={buildNewWorkspaceRoute({
            serverId,
            sourceDirectory,
            displayName,
            projectId,
            draftId,
          })}
        />
        <WorkspaceComposerEditingSessionsProvider
          workspaceKey={NEW_WORKSPACE_SESSIONS_KEY}
          tabIds={sessionTabIds}
        >
          <ComposerEditingScope tabId={draftKey} targetKey={draftKey}>
            <NewWorkspaceScreen
              key={screenKey}
              serverId={serverId}
              sourceDirectory={sourceDirectory}
              displayName={displayName}
              projectId={projectId}
              draftId={draftId}
            />
          </ComposerEditingScope>
        </WorkspaceComposerEditingSessionsProvider>
      </NewWorkspaceDraftScope>
    </HostRouteBootstrapBoundary>
  );
}

function NewWorkspaceDraftPresence(props: { draftId: string; serverId: string; href: string }) {
  useNewWorkspaceTabPresence(props);
  return null;
}
