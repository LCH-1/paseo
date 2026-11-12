import React, { useEffect, useMemo, useSyncExternalStore, type ComponentType } from "react";
import { router, useLocalSearchParams, usePathname } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { isWeb } from "@/constants/platform";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { getProjectWindowScope, projectWindowStorageKey } from "@/project-window/state";
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
  readonly kind?: "history";
  readonly pinned?: boolean;
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

interface NewWorkspaceTabStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function createNewWorkspaceTabSessionStorage(
  getStorage: () => Pick<Storage, "getItem" | "setItem">,
): NewWorkspaceTabStorage {
  return {
    getItem: async (key) => getStorage().getItem(key),
    setItem: async (key, value) => {
      getStorage().setItem(key, value);
    },
  };
}

function isCheckpointRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCheckpointEntry(value: unknown): NewWorkspaceTabEntry {
  if (!isCheckpointRecord(value)) throw new Error("Invalid creation tab checkpoint entry");
  const { draftId, serverId, href, kind, pinned } = value;
  if (
    typeof draftId !== "string" ||
    !draftId ||
    typeof serverId !== "string" ||
    typeof href !== "string" ||
    !href.startsWith("/new?") ||
    new URLSearchParams(href.slice(5)).get("draftId") !== draftId ||
    kind !== undefined ||
    (pinned !== undefined && typeof pinned !== "boolean")
  ) {
    throw new Error("Invalid creation tab checkpoint entry");
  }
  return { draftId, serverId, href, ...(pinned === undefined ? {} : { pinned }) };
}

function readCheckpointEntries(raw: string | null): NewWorkspaceTabEntry[] {
  if (raw === null) return [];
  const decoded: unknown = JSON.parse(raw);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("version" in decoded) ||
    decoded.version !== 1 ||
    !("entries" in decoded) ||
    !Array.isArray(decoded.entries)
  ) {
    throw new Error("Unsupported creation tab checkpoint");
  }
  const entries: NewWorkspaceTabEntry[] = [];
  for (const value of decoded.entries) {
    const entry = readCheckpointEntry(value);
    if (entries.some((previous) => previous.draftId === entry.draftId)) {
      throw new Error("Invalid creation tab checkpoint entry");
    }
    entries.push(entry);
  }
  return entries;
}

export function createNewWorkspaceTabCheckpoint(input: {
  storage: NewWorkspaceTabStorage;
  key: string;
  getEntries(): readonly NewWorkspaceTabEntry[];
  restore(entries: readonly NewWorkspaceTabEntry[]): void;
  beforeRestore?(): Promise<void>;
}) {
  let hydration: Promise<void> | null = null;
  let hydrated = false;
  let writable = true;
  let dirty = false;
  let writing: Promise<void> | null = null;
  let lastSerialized: string | null = null;
  let writeFailed = false;
  const touched = new Set<string>();
  function write() {
    if (!hydrated || !writable || !dirty || writing) return writing;
    writeFailed = false;
    writing = Promise.resolve()
      .then(async () => {
        while (dirty) {
          dirty = false;
          const entries = input.getEntries().filter((entry) => entry.kind !== "history");
          const serialized = JSON.stringify({ version: 1, entries });
          if (serialized === lastSerialized) continue;
          try {
            await input.storage.setItem(input.key, serialized);
            lastSerialized = serialized;
          } catch (error) {
            dirty = true;
            writeFailed = true;
            console.warn("[new-workspace-tabs] Failed to save creation tabs", error);
            break;
          }
        }
        return undefined;
      })
      .finally(() => {
        writing = null;
        if (dirty && !writeFailed) void write();
      });
    return writing;
  }
  function hydrate(): Promise<void> {
    if (hydration) return hydration;
    hydration = (async () => {
      try {
        const raw = await input.storage.getItem(input.key);
        const saved = readCheckpointEntries(raw);
        if (saved.length) await input.beforeRestore?.();
        const current = input.getEntries();
        const currentById = new Map(current.map((entry) => [entry.draftId, entry]));
        const merged = saved.flatMap((entry) => {
          const live = currentById.get(entry.draftId);
          return live ?? (touched.has(entry.draftId) ? [] : entry);
        });
        const savedIds = new Set(saved.map((entry) => entry.draftId));
        merged.push(...current.filter((entry) => !savedIds.has(entry.draftId)));
        if (
          merged.length !== current.length ||
          merged.some((entry, index) => entry !== current[index])
        ) {
          input.restore(merged);
        }
        lastSerialized = raw;
      } catch (error) {
        // An unreadable or newer checkpoint must not be overwritten with an empty state.
        writable = false;
        console.warn("[new-workspace-tabs] Failed to restore creation tabs", error);
      } finally {
        hydrated = true;
        touched.clear();
      }
      await write();
    })();
    return hydration;
  }
  return {
    hydrate,
    touch(draftId: string) {
      if (!hydrated) touched.add(draftId);
      dirty = true;
      void write();
    },
    async flush() {
      await hydrate();
      if (!writable) return;
      do {
        await write();
        if (writeFailed) return;
      } while (writing || dirty);
    },
  };
}

const listeners = new Set<() => void>();
const tabBars: TabBarRegistration[] = [];
const knownDrafts = new Set<string>();
const closedDrafts = new Set<string>();
let snapshot: NewWorkspaceTabsSnapshot = { entries: [], activeDraftId: null, completions: [] };
let sequence = 0;
const adoptedLegacyVersions = new Set<number>();
const checkpoint = createNewWorkspaceTabCheckpoint({
  // Creation tabs have always belonged to their current window. A shared
  // whole-array checkpoint would let two integrated windows overwrite each other.
  storage:
    isWeb && !getProjectWindowScope()
      ? createNewWorkspaceTabSessionStorage(() => globalThis.sessionStorage)
      : AsyncStorage,
  key: projectWindowStorageKey("new-workspace-tabs"),
  getEntries: () => snapshot.entries,
  beforeRestore: () =>
    new Promise((resolve) => {
      if (useDraftStore.persist.hasHydrated()) {
        resolve();
        return;
      }
      const release = useDraftStore.persist.onFinishHydration(() => {
        release();
        resolve();
      });
      if (useDraftStore.persist.hasHydrated()) {
        release();
        resolve();
      }
    }),
  restore(entries) {
    for (const entry of entries) knownDrafts.add(entry.draftId);
    publish({ ...snapshot, entries });
  },
});

export function flushNewWorkspaceTabCheckpoint(): Promise<void> {
  return checkpoint.flush();
}

function publish(next: NewWorkspaceTabsSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function registerDraft(entry: NewWorkspaceTabEntry): void {
  checkpoint.touch(entry.draftId);
  knownDrafts.add(entry.draftId);
  const existing = snapshot.entries.find((item) => item.draftId === entry.draftId);
  const next = existing?.pinned && entry.pinned === undefined ? { ...entry, pinned: true } : entry;
  if (
    existing?.href === next.href &&
    existing.serverId === next.serverId &&
    existing.pinned === next.pinned
  )
    return;
  const entries = snapshot.entries.filter((item) => item.draftId !== entry.draftId);
  const index = existing ? snapshot.entries.indexOf(existing) : entries.length;
  entries.splice(index, 0, next);
  publish({ ...snapshot, entries });
}

export const newWorkspaceTabsBridge = {
  getSnapshot: (): NewWorkspaceTabsSnapshot => snapshot,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  open(options: NewWorkspaceOptions = {}): string {
    const scope = getProjectWindowScope();
    if (scope)
      options = {
        ...options,
        serverId: scope.serverId,
        projectId: scope.projectId,
        sourceDirectory: scope.directory,
        displayName: scope.projectName,
      };
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
  restore(entry: NewWorkspaceTabEntry): void {
    closedDrafts.delete(entry.draftId);
    registerDraft(entry);
  },
  pin(draftId: string): void {
    const entry = snapshot.entries.find((item) => item.draftId === draftId);
    if (entry && entry.kind !== "history" && !entry.pinned) {
      registerDraft({ ...entry, pinned: true });
    }
  },
  hasInput(draftId: string): boolean {
    const draft = useDraftStore.getState().getDraftInput(buildNewWorkspaceDraftKey(draftId));
    return Boolean(draft?.text || draft?.attachments.length);
  },
  dismiss(): void {
    router.replace("/");
  },
  close(draftId: string, options?: { preserveDraft?: boolean }): void {
    checkpoint.touch(draftId);
    const entry = snapshot.entries.find((item) => item.draftId === draftId);
    const entries = snapshot.entries.filter((item) => item.draftId !== draftId);
    if (entry?.kind !== "history" && !options?.preserveDraft) clearNewWorkspaceDraftState(draftId);
    knownDrafts.delete(draftId);
    closedDrafts.add(draftId);
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

export function useHistoryTabPresence(): void {
  const focused = useIsFocused();
  const pathname = usePathname();
  useEffect(() => {
    if (!focused || pathname !== "/sessions") return;
    registerDraft({ draftId: "history", serverId: "", href: "/sessions", kind: "history" });
    publish({ ...snapshot, activeDraftId: "history" });
    return () => {
      if (snapshot.activeDraftId === "history") publish({ ...snapshot, activeDraftId: null });
    };
  }, [focused, pathname]);
}

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
  checkpoint.touch(input.draftId);
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
    if (!focused || pathname !== "/new" || closedDrafts.has(draftId)) return;
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

void checkpoint.hydrate();
