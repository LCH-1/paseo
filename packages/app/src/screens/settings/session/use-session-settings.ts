import { useCallback, useState, useSyncExternalStore } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFetchQuery } from "@/data/query";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import {
  applySessionSettings,
  hasSessionSettings,
  openSessionSettings,
  resolveFastSetting,
  saveSessionDefaults,
  type SessionSettingsSelection,
} from "./model";

type SessionFormState = ReturnType<ReturnType<typeof openSessionSettings>["getState"]>;

function useSessionCatalog(state: SessionFormState) {
  const { t } = useTranslation("sessionSettings");
  const hosts = useHosts();
  const hostId = state.hostId || hosts[0]?.serverId || "";
  const client = useHostRuntimeClient(hostId);
  const connected = useHostRuntimeIsConnected(hostId);
  const catalog = useProvidersSnapshot(hostId || null);
  const defaults = useFormPreferences();
  const providers =
    catalog.entries?.filter((entry) => entry.enabled && entry.status === "ready") ?? [];
  const preferredProvider = state.provider || defaults.preferences.provider;
  const preferredEntry = providers.find((item) => item.provider === preferredProvider);
  const entry = state.provider ? preferredEntry : (preferredEntry ?? providers[0]);
  return { t, hosts, hostId, client, connected, catalog, defaults, providers, entry };
}

type SessionCatalog = ReturnType<typeof useSessionCatalog>;

function useSessionFeatures(catalog: SessionCatalog, selection: SessionSettingsSelection) {
  const { client, connected, hostId, defaults, entry, t } = catalog;
  const provider = entry?.provider ?? "";
  const saved = defaults.preferences.providerPreferences?.[provider];
  const model = selection.model || saved?.model;
  const mode = selection.mode || saved?.mode;
  return useFetchQuery({
    queryKey: ["session-settings-features", hostId, provider, model, mode],
    dataShape: "value",
    staleTimeMs: 300_000,
    enabled: Boolean(client && connected && provider),
    queryFn: async () => {
      if (!client) throw new Error(t("offline"));
      const payload = await client.listProviderFeatures({
        provider,
        cwd: ".",
        model,
        modeId: mode,
      });
      if (payload.error) throw new Error(payload.error);
      return payload.features ?? [];
    },
  });
}

interface SettingsActionInput {
  action: "apply" | "defaults";
  catalog: SessionCatalog;
  state: SessionFormState;
  features: NonNullable<ReturnType<typeof useSessionFeatures>["data"]>;
}

async function executeSettingsAction({ action, catalog, state, features }: SettingsActionInput) {
  const { t, entry, hosts, hostId, defaults } = catalog;
  const provider = entry?.provider ?? "";
  if (action === "defaults") {
    await defaults.updatePreferences((current) =>
      saveSessionDefaults({ preferences: current, provider, selection: state.selection, features }),
    );
    return {
      message: t("saved", { provider: entry?.label ?? provider }),
      failures: [],
      notices: [],
    };
  }
  const targetHosts =
    state.target === "all" ? hosts : hosts.filter((host) => host.serverId === hostId);
  const runtime = getHostRuntimeStore();
  const result = await applySessionSettings({
    provider,
    selection: state.selection,
    hosts: targetHosts.map((host) => ({
      label: host.label,
      client:
        runtime.getSnapshot(host.serverId)?.connectionStatus === "online"
          ? runtime.getClient(host.serverId)
          : null,
    })),
  });
  return {
    message: t("result", {
      applied: result.applied,
      failed: result.failed,
      hosts: result.failures.filter((failure) => !failure.session).length,
    }),
    failures: result.failures,
    notices: [...new Set(result.notices)],
  };
}

export function useSessionSettings() {
  const [form] = useState(openSessionSettings);
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const catalog = useSessionCatalog(state);
  const features = useSessionFeatures(catalog, state.selection);
  const mutation = useMutation({
    mutationFn: (action: SettingsActionInput["action"]) =>
      executeSettingsAction({ action, catalog, state, features: features.data ?? [] }),
  });
  const { reset, mutate, isPending: busy } = mutation;
  const selectHost = useCallback(
    (value: string) => {
      reset();
      form.setHost(value);
    },
    [form, reset],
  );
  const selectProvider = useCallback(
    (value: string) => {
      reset();
      form.setProvider(value);
    },
    [form, reset],
  );
  const selectModel = useCallback(
    (value: string) => {
      reset();
      form.select({ model: value, fast: "keep" });
    },
    [form, reset],
  );
  const selectMode = useCallback(
    (value: string) => {
      reset();
      form.select({ mode: value, fast: "keep" });
    },
    [form, reset],
  );
  const selectFast = useCallback(
    (value: SessionSettingsSelection["fast"]) => {
      reset();
      form.select({ fast: value });
    },
    [form, reset],
  );
  const selectTarget = useCallback(
    (value: string) => {
      reset();
      form.setTarget(value);
    },
    [form, reset],
  );
  const apply = useCallback(() => mutate("apply"), [mutate]);
  const save = useCallback(() => mutate("defaults"), [mutate]);
  const fastSupported = Boolean(
    resolveFastSetting(features.data ?? [], true) && resolveFastSetting(features.data ?? [], false),
  );
  const waitingForFast = state.selection.fast !== "keep" && features.isFetching;
  const disabled =
    busy ||
    catalog.defaults.isLoading ||
    !catalog.connected ||
    !catalog.entry ||
    !hasSessionSettings(state.selection) ||
    waitingForFast;
  const models = filterSelectableModels(catalog.entry?.models ?? []) ?? [];
  return {
    ...catalog,
    state,
    features,
    mutation,
    busy,
    disabled,
    fastSupported,
    models,
    selectHost,
    selectProvider,
    selectModel,
    selectMode,
    selectFast,
    selectTarget,
    apply,
    save,
  };
}

export type SessionSettings = ReturnType<typeof useSessionSettings>;
