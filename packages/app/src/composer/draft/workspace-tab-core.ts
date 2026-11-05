import { resolveSubmissionReadiness } from "@/provider-selection/provider-selection";

export interface WorkspaceDraftAutoSubmitConfig {
  provider: string;
  model: string | null;
}

export interface CreationFailureNotice {
  error: string;
  prompt: string | null;
}

/** A live attempt reports its own outcome, so the stored failure only speaks for an idle draft. */
export function resolveCreationFailureNotice(input: {
  failure: { error: string; prompt?: string } | null | undefined;
  isSubmitting: boolean;
  formErrorMessage: string | null | undefined;
}): CreationFailureNotice | null {
  const { failure, isSubmitting, formErrorMessage } = input;
  if (!failure || isSubmitting || formErrorMessage) return null;
  return { error: failure.error, prompt: failure.prompt?.trim() ? failure.prompt : null };
}

function stableIntentJson(intent: unknown): string {
  return (
    JSON.stringify(intent, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
    ) ?? ""
  );
}

/**
 * The daemon binds an idempotency key to one request. Resubmitting the same intent joins it, while
 * editing a failed draft (another provider, model or prompt) is a new request, not a key conflict.
 */
export function buildDraftCreationKey(draftId: string, intent: unknown): string {
  const json = stableIntentJson(intent);
  let hash = 2166136261;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${draftId}:${(hash >>> 0).toString(36)}`;
}

/**
 * Once creation has produced a workspace, a retry only needs a new agent inside it. An unknown
 * outcome may have reached the provider, so it rejoins the original request instead.
 */
export function resolveDraftCreationRetry(input: {
  createdWorkspaceId: string | null;
  outcomeUnknown: boolean;
}): "create-agent" | "rejoin-original" | "create-workspace" {
  if (input.outcomeUnknown) return "rejoin-original";
  return input.createdWorkspaceId ? "create-agent" : "create-workspace";
}

export function shouldAllowEmptyDraftText(input: {
  allowsEmptyAutoSubmit: boolean;
  attachments: readonly unknown[];
}): boolean {
  return input.allowsEmptyAutoSubmit || input.attachments.length > 0;
}

export function validateDraftSubmission(input: {
  text: string;
  allowsEmptyAutoSubmit: boolean;
  composerState: {
    providerDefinitions: unknown[];
    selectedProvider: string | null;
    isModelLoading: boolean;
    effectiveModelId: string | null;
    availableModels: unknown[];
  };
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  workspaceDirectory: string | null;
  isConnected: boolean;
}): string | null {
  const {
    text,
    allowsEmptyAutoSubmit,
    composerState,
    autoSubmitConfig,
    workspaceDirectory,
    isConnected,
  } = input;
  const readiness = resolveSubmissionReadiness({
    text,
    allowsEmptyAutoSubmit,
    providerCount: composerState.providerDefinitions.length,
    selection: {
      provider: composerState.selectedProvider,
      modelId: composerState.effectiveModelId ?? "",
      availableModels: composerState.availableModels,
      isModelLoading: composerState.isModelLoading,
    },
    autoSubmitConfig,
    workspaceDirectory,
    isConnected,
  });
  return readiness.ok ? null : (readiness.reason ?? null);
}
