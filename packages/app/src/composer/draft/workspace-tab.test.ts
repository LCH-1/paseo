import { describe, expect, test } from "vitest";

import {
  buildDraftCreationKey,
  resolveCreationFailureNotice,
  resolveDraftCreationRetry,
  shouldAllowEmptyDraftText,
  validateDraftSubmission,
} from "./workspace-tab-core";

const baseComposerState = {
  providerDefinitions: [{ id: "codewhale" }],
  selectedProvider: "codewhale",
  isModelLoading: false,
  effectiveModelId: "",
  availableModels: [],
};

function validate(overrides = {}) {
  return validateDraftSubmission({
    text: "hello",
    allowsEmptyAutoSubmit: false,
    composerState: baseComposerState,
    autoSubmitConfig: null,
    workspaceDirectory: "/tmp/project",
    isConnected: true,
    ...overrides,
  });
}

describe("workspace draft agent model validation", () => {
  test("reports an offline host before an absent catalog or pending model defaults", () => {
    expect(
      validate({
        isConnected: false,
        composerState: {
          ...baseComposerState,
          providerDefinitions: [],
          selectedProvider: null,
          isModelLoading: true,
        },
      }),
    ).toBe("Host is not connected");
  });

  test("allows a ready provider with no models to submit without a selected model", () => {
    expect(validate({})).toBeNull();
  });

  test("keeps waiting while model defaults are loading", () => {
    expect(
      validate({
        composerState: {
          ...baseComposerState,
          isModelLoading: true,
        },
      }),
    ).toBe("Model defaults are still loading");
  });

  test("still requires a selected model when the provider exposes models", () => {
    expect(
      validate({
        composerState: {
          ...baseComposerState,
          availableModels: [{ id: "deepseek/deepseek-v4-pro" }],
        },
      }),
    ).toBe("No model is available for the selected provider");
  });
});

describe("workspace draft empty text readiness", () => {
  test("allows attachment-only retries after a fork draft create fails", () => {
    expect(
      shouldAllowEmptyDraftText({
        allowsEmptyAutoSubmit: false,
        attachments: [{ kind: "chat_history" }],
      }),
    ).toBe(true);
  });

  test("still rejects empty drafts with no auto-submit and no attachments", () => {
    expect(
      shouldAllowEmptyDraftText({
        allowsEmptyAutoSubmit: false,
        attachments: [],
      }),
    ).toBe(false);
  });
});

describe("resolveCreationFailureNotice", () => {
  const idle = { isSubmitting: false, formErrorMessage: null };
  test("shows a stored failure on an idle draft and offers its prompt", () => {
    expect(
      resolveCreationFailureNotice({ failure: { error: "blocked", prompt: "hello" }, ...idle }),
    ).toEqual({ state: "previous", error: "blocked", prompt: "hello" });
  });
  test("treats a missing or blank prompt as unrecoverable", () => {
    expect(resolveCreationFailureNotice({ failure: { error: "blocked" }, ...idle })?.prompt).toBe(
      null,
    );
    expect(
      resolveCreationFailureNotice({ failure: { error: "blocked", prompt: "  " }, ...idle })
        ?.prompt,
    ).toBe(null);
  });
  test("prefers the re-evaluated state over the stored failure", () => {
    expect(
      resolveCreationFailureNotice({
        failure: { error: "old", recheck: { status: "ready" } },
        ...idle,
      }),
    ).toEqual({ state: "resolved", error: null, prompt: null });
    expect(
      resolveCreationFailureNotice({
        failure: { error: "old", recheck: { status: "blocked", error: "new" } },
        ...idle,
      }),
    ).toEqual({ state: "blocked", error: "new", prompt: null });
  });
  test("yields to a live attempt", () => {
    const failure = { error: "blocked" };
    expect(resolveCreationFailureNotice({ failure, ...idle, isSubmitting: true })).toBe(null);
    expect(resolveCreationFailureNotice({ failure, ...idle, formErrorMessage: "new" })).toBe(null);
    expect(resolveCreationFailureNotice({ failure: null, ...idle })).toBe(null);
  });
});

describe("failed draft resubmission", () => {
  const intent = { config: { provider: "codex", model: "a" }, initialPrompt: "hello" };

  test("keeps one key for the same intent regardless of property order", () => {
    expect(buildDraftCreationKey("draft", intent)).toBe(
      buildDraftCreationKey("draft", {
        initialPrompt: "hello",
        config: { model: "a", provider: "codex" },
      }),
    );
  });

  test("uses a new key when the provider or prompt changes", () => {
    const original = buildDraftCreationKey("draft", intent);
    expect(
      buildDraftCreationKey("draft", {
        ...intent,
        config: { ...intent.config, provider: "claude" },
      }),
    ).not.toBe(original);
    expect(buildDraftCreationKey("draft", { ...intent, initialPrompt: "edited" })).not.toBe(
      original,
    );
  });

  test("adds an agent to the created workspace unless the outcome is unknown", () => {
    expect(resolveDraftCreationRetry({ createdWorkspaceId: "wks_1", outcomeUnknown: false })).toBe(
      "create-agent",
    );
    expect(resolveDraftCreationRetry({ createdWorkspaceId: "wks_1", outcomeUnknown: true })).toBe(
      "rejoin-original",
    );
    expect(resolveDraftCreationRetry({ createdWorkspaceId: null, outcomeUnknown: false })).toBe(
      "create-workspace",
    );
  });
});
