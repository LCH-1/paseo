/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCreationFailureNotice } from "./creation-failure-notice";

const FABLE_REFUSAL = "Every account has used up its Fable limit";
const STORED_ERROR = `Plugin aster before agent.session_open failed: ${FABLE_REFUSAL}`;

/** A host whose session-open hook refuses Fable and accepts every other model. */
function createHost() {
  const findCreationFailure = vi.fn(
    async (_workspaceId: string, provider?: string, model?: string) => {
      const stored = { error: STORED_ERROR, outcomeUnknown: false, prompt: "Keep this message" };
      if (!provider) return stored;
      return model === "claude-fable-5-2"
        ? { ...stored, recheck: { status: "blocked" as const, error: FABLE_REFUSAL } }
        : { ...stored, recheck: { status: "ready" as const } };
    },
  );
  return { findCreationFailure };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

function renderNotice(
  host: ReturnType<typeof createHost>,
  selection: { provider: string | null; model: string | null; isModelLoading?: boolean },
) {
  return renderHook(
    (current: typeof selection) =>
      useCreationFailureNotice({
        serverId: "server-1",
        workspaceId: "wks_blocked",
        client: host,
        isConnected: true,
        provider: current.provider,
        model: current.model,
        isModelLoading: current.isModelLoading ?? false,
        hasPendingCreation: false,
        isSubmitting: false,
        formErrorMessage: null,
      }),
    { wrapper, initialProps: selection },
  );
}

describe("creation failure notice", () => {
  it("asks the host about the model the draft would start a session with", async () => {
    const host = createHost();
    const { result } = renderNotice(host, { provider: "claude", model: "claude-fable-5-2" });

    await waitFor(() => expect(result.current?.state).toBe("blocked"));
    expect(result.current).toEqual({
      state: "blocked",
      error: FABLE_REFUSAL,
      prompt: "Keep this message",
    });
    expect(host.findCreationFailure.mock.calls).toEqual([
      ["wks_blocked", "claude", "claude-fable-5-2"],
    ]);
  });

  it("asks again when the draft selects another model", async () => {
    const host = createHost();
    const { result, rerender } = renderNotice(host, {
      provider: "claude",
      model: "claude-fable-5-2",
    });
    await waitFor(() => expect(result.current?.state).toBe("blocked"));

    rerender({ provider: "claude", model: "claude-opus-4-8" });

    await waitFor(() => expect(result.current?.state).toBe("resolved"));
    expect(host.findCreationFailure.mock.calls).toEqual([
      ["wks_blocked", "claude", "claude-fable-5-2"],
      ["wks_blocked", "claude", "claude-opus-4-8"],
    ]);
  });

  it("shows the stored failure without re-evaluating it while no model is known yet", async () => {
    const host = createHost();
    const { result, rerender } = renderNotice(host, {
      provider: "claude",
      model: "",
      isModelLoading: true,
    });

    // Asking now would be asking about no model, and the host would not refuse on Fable's limit.
    await waitFor(() => expect(result.current?.state).toBe("previous"));
    expect(result.current?.error).toBe(STORED_ERROR);
    expect(host.findCreationFailure.mock.calls).toEqual([["wks_blocked", undefined, undefined]]);

    rerender({ provider: "claude", model: "claude-fable-5-2", isModelLoading: false });

    await waitFor(() => expect(result.current?.state).toBe("blocked"));
    expect(host.findCreationFailure.mock.calls.at(-1)).toEqual([
      "wks_blocked",
      "claude",
      "claude-fable-5-2",
    ]);
  });

  it("keeps asking about the chosen model while the provider's models refresh", async () => {
    const host = createHost();
    const { result, rerender } = renderNotice(host, {
      provider: "claude",
      model: "claude-fable-5-2",
    });
    await waitFor(() => expect(result.current?.state).toBe("blocked"));

    rerender({ provider: "claude", model: "claude-fable-5-2", isModelLoading: true });

    expect(result.current?.state).toBe("blocked");
    expect(host.findCreationFailure.mock.calls).toEqual([
      ["wks_blocked", "claude", "claude-fable-5-2"],
    ]);
  });

  it("asks about the provider alone when it offers no model", async () => {
    const host = createHost();
    const { result } = renderNotice(host, { provider: "codewhale", model: "" });

    await waitFor(() => expect(result.current?.state).toBe("resolved"));
    expect(host.findCreationFailure.mock.calls).toEqual([["wks_blocked", "codewhale", undefined]]);
  });
});
