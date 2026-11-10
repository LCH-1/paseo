import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  shouldClearAgentAttention,
  type AgentAttentionClearTrigger,
} from "@/utils/agent-attention";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import { isWeb } from "@/constants/platform";

type AttentionReason = "finished" | "error" | "permission" | null | undefined;

interface UseAgentAttentionClearParams {
  agentId: string | null | undefined;
  client: DaemonClient | null;
  isConnected: boolean;
  requiresAttention: boolean | null | undefined;
  attentionReason: AttentionReason;
  attentionTimestamp?: Date | number | null;
  isScreenFocused: boolean;
  isContentReady: boolean;
}

interface AgentAttentionClearController {
  clearOnInputFocus: () => void;
  clearOnPromptSend: () => void;
  clearOnAgentBlur: () => void;
}

interface AttentionClearRequest {
  agentId: string;
  client: DaemonClient;
  attentionTimestamp: number | null;
  attentionReason: AttentionReason;
  promise: Promise<boolean>;
}

const COMPLETION_ACK_RETRY_DELAYS_MS = [500, 1500, 4000];
// Past the quick retries the host is struggling, not blinking: keep the displayed
// conversation converging, at a pace that cannot pile requests onto it.
const COMPLETION_ACK_SLOW_RETRY_DELAY_MS = 30_000;

export function useAgentAttentionClear({
  agentId,
  client,
  isConnected,
  requiresAttention,
  attentionReason,
  attentionTimestamp,
  isScreenFocused,
  isContentReady,
}: UseAgentAttentionClearParams): AgentAttentionClearController {
  const [isAppVisible, setIsAppVisible] = useState<boolean>(() => getIsAppActivelyVisible());
  const deferredFocusEntryClearRef = useRef(false);
  const prevRequiresAttentionRef = useRef(Boolean(requiresAttention));
  const prevActivelyViewedRef = useRef(isScreenFocused && getIsAppActivelyVisible());
  const prevScreenFocusedRef = useRef(false);
  const prevAppVisibleRef = useRef(getIsAppActivelyVisible());
  const requests = useRef(new Set<AttentionClearRequest>());
  const attentionTimestampMs =
    attentionTimestamp instanceof Date
      ? attentionTimestamp.getTime()
      : (attentionTimestamp ?? null);

  const clearAttention = useCallback(
    (trigger: AgentAttentionClearTrigger) => {
      const resolvedAgentId = agentId?.trim();
      if (!client || !resolvedAgentId) {
        return;
      }
      if (
        !shouldClearAgentAttention({
          agentId: resolvedAgentId,
          isConnected,
          requiresAttention,
          attentionReason,
          trigger,
          hasDeferredFocusEntryClear: deferredFocusEntryClearRef.current,
        })
      ) {
        return;
      }
      deferredFocusEntryClearRef.current = false;
      const pending = [...requests.current].find(
        (request) =>
          request.client === client &&
          request.agentId === resolvedAgentId &&
          request.attentionTimestamp === attentionTimestampMs &&
          request.attentionReason === attentionReason,
      );
      if (pending) return pending.promise;
      const request: AttentionClearRequest = {
        client,
        agentId: resolvedAgentId,
        attentionTimestamp: attentionTimestampMs,
        attentionReason,
        promise: client.clearAgentAttention(resolvedAgentId).then(
          () => true,
          () => false,
        ),
      };
      requests.current.add(request);
      void request.promise.then(() => requests.current.delete(request));
      return request.promise;
    },
    [agentId, attentionReason, attentionTimestampMs, client, isConnected, requiresAttention],
  );

  useEffect(() => {
    const updateVisibility = () => {
      setIsAppVisible(getIsAppActivelyVisible());
    };

    const appStateSubscription = AppState.addEventListener("change", updateVisibility);

    if (isWeb && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", updateVisibility);
      window.addEventListener("focus", updateVisibility);
      window.addEventListener("blur", updateVisibility);

      return () => {
        appStateSubscription.remove();
        document.removeEventListener("visibilitychange", updateVisibility);
        window.removeEventListener("focus", updateVisibility);
        window.removeEventListener("blur", updateVisibility);
      };
    }

    return () => {
      appStateSubscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!requiresAttention) {
      deferredFocusEntryClearRef.current = false;
    }
  }, [requiresAttention]);

  useEffect(() => {
    const isActivelyViewed = isScreenFocused && isAppVisible;
    if (
      !prevRequiresAttentionRef.current &&
      Boolean(requiresAttention) &&
      prevActivelyViewedRef.current &&
      isActivelyViewed
    ) {
      deferredFocusEntryClearRef.current = true;
    }
    prevRequiresAttentionRef.current = Boolean(requiresAttention);
    prevActivelyViewedRef.current = isActivelyViewed;
  }, [isAppVisible, isScreenFocused, requiresAttention]);

  useEffect(() => {
    const enteredScreenFocus = !prevScreenFocusedRef.current && isScreenFocused && isAppVisible;
    const resumedIntoFocusedAgent = !prevAppVisibleRef.current && isAppVisible && isScreenFocused;

    if ((enteredScreenFocus || resumedIntoFocusedAgent) && attentionReason !== "finished") {
      clearAttention("focus-entry");
    }

    prevScreenFocusedRef.current = isScreenFocused;
    prevAppVisibleRef.current = isAppVisible;
  }, [attentionReason, clearAttention, isAppVisible, isScreenFocused]);

  useEffect(() => {
    if (
      !isScreenFocused ||
      !isAppVisible ||
      !isContentReady ||
      !isConnected ||
      !requiresAttention ||
      attentionReason !== "finished"
    ) {
      return;
    }
    let cancelled = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function acknowledgeCompletion() {
      const acknowledged = await clearAttention("viewed-completion");
      if (cancelled || acknowledged !== false) {
        return;
      }
      const delay = COMPLETION_ACK_RETRY_DELAYS_MS[retry] ?? COMPLETION_ACK_SLOW_RETRY_DELAY_MS;
      retry += 1;
      timer = setTimeout(() => {
        timer = null;
        void acknowledgeCompletion();
      }, delay);
    }
    void acknowledgeCompletion();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [
    attentionReason,
    clearAttention,
    isAppVisible,
    isConnected,
    isContentReady,
    isScreenFocused,
    requiresAttention,
  ]);

  return {
    clearOnInputFocus: useCallback(() => {
      clearAttention("input-focus");
    }, [clearAttention]),
    clearOnPromptSend: useCallback(() => {
      clearAttention("prompt-send");
    }, [clearAttention]),
    clearOnAgentBlur: useCallback(() => {
      clearAttention("agent-blur");
    }, [clearAttention]),
  };
}
