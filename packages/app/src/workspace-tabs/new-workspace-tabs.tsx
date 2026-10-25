import React, { useEffect, useMemo, useSyncExternalStore, type ComponentType } from "react";
import { router, useLocalSearchParams, usePathname } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { buildNewWorkspaceDraftKey, generateDraftId } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { getLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  buildDeterministicWorkspaceTabId,
  workspaceTabTargetsEqual,
} from "@/workspace-tabs/identity";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { NewTabLauncherProvider, type NewTabLauncher } from "@/workspace-tabs/launcher";
import { clearNewWorkspaceDraftState } from "./new-workspace-draft-state";

export interface NewWorkspaceTabEntry {
  readonly draftId: string;
  readonly serverId: string;
  readonly href: string;
}

export interface NewWorkspaceTabCompletion {
  readonly sequence: number;
  readonly draftId: string;
  readonly serverId: string;
  readonly workspaceId: string;
  readonly target: WorkspaceTabTarget | null;
  readonly tabId: string | null;
}

export interface NewWorkspaceTabsSnapshot {
  readonly entries: readonly NewWorkspaceTabEntry[];
  readonly activeDraftId: string | null;
  readonly completions: readonly NewWorkspaceTabCompletion[];
}

interface NewWorkspaceOptions {
  serverId?: string;
  sourceDirectory?: string;
  displayName?: string;
  projectId?: string;
}

interface TabBarRegistration {
  Component: ComponentType;
}

const listeners = new Set<() => void>();
const tabBars: TabBarRegistration[] = [];
const knownDrafts = new Set<string>();
let snapshot: NewWorkspaceTabsSnapshot = { entries: [], activeDraftId: null, completions: [] };
let sequence = 0;
const adoptedLegacyVersions = new Set<number>();

function publish(next: NewWorkspaceTabsSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function registerDraft(entry: NewWorkspaceTabEntry): void {
  knownDrafts.add(entry.draftId);
  const existing = snapshot.entries.find((item) => item.draftId === entry.draftId);
  if (existing?.href === entry.href && existing.serverId === entry.serverId) return;
  const entries = snapshot.entries.filter((item) => item.draftId !== entry.draftId);
  const index = existing ? snapshot.entries.indexOf(existing) : entries.length;
  entries.splice(index, 0, entry);
  publish({ ...snapshot, entries });
}

export const newWorkspaceTabsBridge = {
  getSnapshot: (): NewWorkspaceTabsSnapshot => snapshot,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  open(options: NewWorkspaceOptions = {}): string {
    const draftId = generateDraftId();
    const href = buildNewWorkspaceRoute({ ...options, draftId });
    registerDraft({ draftId, serverId: options.serverId ?? "", href });
    router.push(href as never);
    return draftId;
  },
  activate(draftId: string): void {
    const entry = snapshot.entries.find((item) => item.draftId === draftId);
    if (entry) router.navigate(entry.href as never);
  },
  close(draftId: string): void {
    const entries = snapshot.entries.filter((entry) => entry.draftId !== draftId);
    clearNewWorkspaceDraftState(draftId);
    knownDrafts.delete(draftId);
    if (entries.length === snapshot.entries.length) return;
    publish({
      ...snapshot,
      entries,
      activeDraftId: snapshot.activeDraftId === draftId ? null : snapshot.activeDraftId,
    });
  },
  registerTabBar(Component: ComponentType): () => void {
    const registration = { Component };
    tabBars.push(registration);
    publish({ ...snapshot });
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = tabBars.indexOf(registration);
      if (index !== -1) tabBars.splice(index, 1);
      publish({ ...snapshot });
    };
  },
};

export async function adoptLegacyNewWorkspaceDraft(draftId: string): Promise<void> {
  const store = useDraftStore.getState();
  const legacyKey = buildNewWorkspaceDraftKey();
  const version = store.drafts[legacyKey]?.version;
  if (version === undefined || adoptedLegacyVersions.has(version)) return;
  const legacy = await store.hydrateDraftInput({ draftKey: legacyKey });
  if (!legacy) return;
  const draftKey = buildNewWorkspaceDraftKey(draftId);
  if (!useDraftStore.getState().getDraftInput(draftKey)) {
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: { text: legacy.text, attachments: [...legacy.attachments] },
    });
  }
  adoptedLegacyVersions.add(version);
}

export function completeNewWorkspaceTab(
  input: Omit<NewWorkspaceTabCompletion, "sequence" | "tabId"> & { tabId?: string },
): void {
  if (!knownDrafts.has(input.draftId)) return;
  const workspaceKey = `${input.serverId}:${input.workspaceId}`;
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  const tabs = layout ? collectAllTabs(layout.root) : [];
  const target = input.target;
  const existing = target ? tabs.find((tab) => workspaceTabTargetsEqual(tab.target, target)) : null;
  const handoff =
    target?.kind === "agent"
      ? tabs.find((tab) => tab.target.kind === "draft" && tab.target.draftId === input.draftId)
      : null;
  const deterministicTabId =
    target && target.kind !== "new_tab" ? buildDeterministicWorkspaceTabId(target) : null;
  const tabId = input.tabId ?? existing?.tabId ?? handoff?.tabId ?? deterministicTabId;
  sequence += 1;
  const completion = { ...input, sequence, tabId };
  const entries = snapshot.entries.filter((entry) => entry.draftId !== input.draftId);
  publish({
    entries,
    activeDraftId: snapshot.activeDraftId === input.draftId ? null : snapshot.activeDraftId,
    completions: [...snapshot.completions, completion].slice(-100),
  });
  if (input.target?.kind !== "draft") {
    knownDrafts.delete(input.draftId);
    clearNewWorkspaceDraftState(input.draftId);
  }
}

export function completeNewWorkspaceLaunch(
  input: Parameters<typeof completeNewWorkspaceTab>[0],
  callbacks: { isCurrent: () => boolean; navigate: () => void },
): void {
  const shouldNavigate = callbacks.isCurrent();
  completeNewWorkspaceTab(input);
  if (shouldNavigate) callbacks.navigate();
}

export function useNewWorkspaceTabPresence(input: {
  draftId: string;
  serverId: string;
  href: string;
}): void {
  const focused = useIsFocused();
  const pathname = usePathname();
  const { draftId, serverId, href } = input;
  useEffect(() => {
    if (!focused || pathname !== "/new") return;
    const existing = snapshot.entries.find((entry) => entry.draftId === draftId);
    registerDraft({ draftId, serverId: existing?.serverId || serverId, href });
    if (focused && pathname === "/new" && snapshot.activeDraftId !== draftId) {
      publish({ ...snapshot, activeDraftId: draftId });
    }
    return () => {
      if (snapshot.activeDraftId === draftId) publish({ ...snapshot, activeDraftId: null });
    };
  }, [draftId, focused, href, pathname, serverId]);
}

export function updateNewWorkspaceTabServer(draftId: string, serverId: string): void {
  const entry = snapshot.entries.find((item) => item.draftId === draftId);
  if (entry && entry.serverId !== serverId) registerDraft({ ...entry, serverId });
}

export function NewWorkspaceTabsBar() {
  const state = useSyncExternalStore(
    newWorkspaceTabsBridge.subscribe,
    newWorkspaceTabsBridge.getSnapshot,
    newWorkspaceTabsBridge.getSnapshot,
  );
  const params = useLocalSearchParams<{ serverId?: string; dir?: string; projectId?: string }>();
  const launcher = useMemo<NewTabLauncher>(
    () => ({
      showChanges: false,
      showPullRequest: false,
      showBrowser: false,
      creationOnly: true,
      terminalDisabled: true,
      launch(selection) {
        if (selection.kind !== "agent") return;
        newWorkspaceTabsBridge.open({
          serverId: params.serverId ?? getLastWorkspaceSelection()?.serverId,
          sourceDirectory: params.dir,
          projectId: params.projectId,
        });
      },
    }),
    [params.dir, params.projectId, params.serverId],
  );
  const registration = tabBars.at(-1);
  if (!registration || state.activeDraftId === null) return null;
  const Component = registration.Component;
  return (
    <NewTabLauncherProvider value={launcher}>
      <Component />
    </NewTabLauncherProvider>
  );
}
