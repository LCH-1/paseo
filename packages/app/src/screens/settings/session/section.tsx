import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@/components/settings";
import { useSessionSettings, type SessionSettings } from "./use-session-settings";

interface SettingsProps {
  settings: SessionSettings;
}

function CatalogCard({ settings }: SettingsProps) {
  const { t, hosts, hostId, connected, catalog, providers, busy, selectHost } = settings;
  return (
    <SettingsCard>
      {hosts.length > 0 ? (
        <SettingsSelect
          label={t("catalogHost")}
          value={hostId}
          options={hosts.map((host) => ({ value: host.serverId, label: host.label }))}
          onValueChange={selectHost}
          disabled={busy}
        />
      ) : null}
      {!connected ? <SettingsRow label={t("offline")} /> : null}
      {connected && !catalog.supportsSnapshot ? <SettingsRow label={t("update")} /> : null}
      {catalog.isLoading ? <SettingsRow label={t("loading")} /> : null}
      {catalog.error ? <SettingsRow label={t("title")} error={catalog.error} /> : null}
      {connected && catalog.entries && !providers.length ? (
        <SettingsRow label={t("unavailable")} />
      ) : null}
    </SettingsCard>
  );
}

function SelectionCard({ settings }: SettingsProps) {
  const {
    t,
    entry,
    providers,
    state,
    models,
    features,
    fastSupported,
    busy,
    disabled,
    selectProvider,
    selectModel,
    selectMode,
    selectFast,
    selectTarget,
    apply,
    save,
  } = settings;
  if (!entry) return null;
  return (
    <SettingsCard>
      <SettingsSelect
        label={t("provider")}
        value={entry.provider}
        options={providers.map((item) => ({
          value: item.provider,
          label: item.label ?? item.provider,
        }))}
        onValueChange={selectProvider}
        disabled={busy}
      />
      <SettingsSelect
        label={t("model")}
        value={state.selection.model}
        options={[
          { value: "", label: t("keep") },
          ...models.map((item) => ({ value: item.id, label: item.label })),
        ]}
        onValueChange={selectModel}
        disabled={busy}
      />
      <SettingsSelect
        label={t("access")}
        value={state.selection.mode}
        options={[
          { value: "", label: t("keep") },
          ...(entry.modes ?? []).map((item) => ({ value: item.id, label: item.label })),
        ]}
        onValueChange={selectMode}
        disabled={busy}
      />
      {fastSupported ? (
        <SettingsSelect
          label={t("fast")}
          value={state.selection.fast}
          options={[
            { value: "keep", label: t("keep") },
            { value: "on", label: t("on") },
            { value: "off", label: t("off") },
          ]}
          onValueChange={selectFast}
          disabled={busy || features.isFetching}
        />
      ) : null}
      {features.error ? (
        <SettingsRow
          label={t("fast")}
          error={t("featuresError", { message: features.error.message })}
        />
      ) : null}
      <SettingsSelect
        label={t("target")}
        value={state.target}
        options={[
          { value: "all", label: t("allHosts") },
          { value: "host", label: t("selectedHost") },
        ]}
        onValueChange={selectTarget}
        disabled={busy}
      />
      <SettingsAction
        label={t("apply")}
        actionLabel={busy ? t("working") : t("applyLabel")}
        disabled={disabled}
        onPress={apply}
      />
      <SettingsAction
        label={t("defaults")}
        actionLabel={t("save")}
        disabled={disabled}
        onPress={save}
      />
    </SettingsCard>
  );
}

function ResultCard({ settings }: SettingsProps) {
  const { mutation, t } = settings;
  const { data, error } = mutation;
  if (!error && !data) return null;
  const failureText = data?.failures
    .map((failure) => `${failure.host} ${failure.session}: ${failure.message}`)
    .join("\n");
  return (
    <SettingsCard>
      {error ? <SettingsRow label={t("title")} error={error.message} /> : null}
      {data ? (
        <SettingsRow
          label={data.message}
          error={failureText}
          hint={data.failures.length ? t("partial") : undefined}
        />
      ) : null}
      {data?.notices.map((notice) => (
        <SettingsRow key={notice} label={notice} />
      ))}
    </SettingsCard>
  );
}

export function SessionSettingsSection() {
  const settings = useSessionSettings();
  const { t, entry } = settings;
  return (
    <SettingsSection
      title={t("title")}
      info={entry ? t("scope", { provider: entry.label ?? entry.provider }) : undefined}
      testID="session-settings"
    >
      <CatalogCard settings={settings} />
      <SelectionCard settings={settings} />
      <ResultCard settings={settings} />
    </SettingsSection>
  );
}
