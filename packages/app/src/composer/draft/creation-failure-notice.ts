import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQuery } from "@/data/query";
import {
  type CreationFailureNotice,
  resolveCreationFailureNotice,
} from "@/composer/draft/workspace-tab-core";

/**
 * Why the workspace has no session, re-evaluated for the provider and model the draft would start
 * one with: a host can refuse one model and accept another. The daemon is the only owner of this
 * failure, since the draft that hit it may be long gone.
 */
export function useCreationFailureNotice(input: {
  serverId: string;
  workspaceId: string;
  client: Pick<DaemonClient, "findCreationFailure"> | null;
  isConnected: boolean;
  provider: string | null;
  /** Empty or null when the provider offers no model. */
  model: string | null;
  isModelLoading: boolean;
  hasPendingCreation: boolean;
  isSubmitting: boolean;
  formErrorMessage: string | null | undefined;
}): CreationFailureNotice | null {
  const { serverId, workspaceId, client, isConnected, hasPendingCreation } = input;
  // While the models still load and none is chosen, which model a new session would use is not
  // known. Until then the failure is shown as it was stored, not re-evaluated without a model.
  const provider = input.isModelLoading && !input.model ? null : input.provider;
  const model = (provider && input.model) || null;
  const query = useFetchQuery({
    queryKey: ["creationFailure", serverId, workspaceId, provider, model],
    dataShape: "value",
    staleTimeMs: 0,
    enabled: Boolean(client && isConnected && !hasPendingCreation),
    retry: false,
    // Only a recorded failure is worth re-evaluating; accounts recover without any app event.
    refetchInterval: (current) => (current.state.data ? 60_000 : false),
    refetchOnWindowFocus: true,
    queryFn: async () =>
      client
        ? client.findCreationFailure(workspaceId, provider ?? undefined, model ?? undefined)
        : null,
  });
  return resolveCreationFailureNotice({
    failure: query.data,
    isSubmitting: input.isSubmitting,
    formErrorMessage: input.formErrorMessage,
  });
}
