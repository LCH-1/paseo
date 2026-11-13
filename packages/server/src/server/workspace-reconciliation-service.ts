import { lstatSync, statSync, watch as watchPath } from "node:fs";
import { join } from "node:path";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import type pino from "pino";
import type {
  ProjectRegistry,
  WorkspaceRegistry,
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import type { WorkspaceGitCheckoutOptions, WorkspaceGitService } from "./workspace-git-service.js";
import { areEquivalentPaths } from "../utils/path.js";
import {
  deriveProjectKind,
  reconcileWorkspacePlacement,
  type MutableWorkspacePlacement,
} from "./workspace-registry-model.js";
import { workspaceIdsForProjects } from "./workspace-directory.js";
import { deriveProjectKey } from "./project-key.js";

const DEFAULT_RESCAN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DEBOUNCE_MS = 100;

export type ProjectUpdate =
  | { kind: "upsert"; project: PersistedProjectRecord }
  | { kind: "remove"; projectId: string };

interface ProjectRootWatcher {
  close(): void;
}

export interface ProjectRootWatch {
  (
    rootPath: string,
    options: { recursive: false },
    onChange: (event: string, filename: string | Buffer | null) => void,
    onError: (error: Error) => void,
  ): ProjectRootWatcher;
}

export interface ReconciliationTimer {
  unref?(): void;
}

export interface ReconciliationClock {
  setTimeout(callback: () => void | Promise<void>, delayMs: number): ReconciliationTimer;
  clearTimeout(timer: ReconciliationTimer): void;
  setInterval(callback: () => void | Promise<void>, delayMs: number): ReconciliationTimer;
  clearInterval(timer: ReconciliationTimer): void;
}

const systemClock: ReconciliationClock = {
  setTimeout: (callback, delayMs) => setTimeout(() => void callback(), delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  setInterval: (callback, delayMs) => setInterval(() => void callback(), delayMs),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

const watchProjectRoot: ProjectRootWatch = (rootPath, options, onChange, onError) => {
  const watcher = watchPath(rootPath, options, onChange);
  watcher.on("error", onError);
  return watcher;
};

/**
 * Identifies what `<root>/.git` is. The root watch exists to see a repository appear, vanish, or
 * be replaced, so a directory is its kind and identity only: writes inside it belong to the
 * repository metadata watcher, and Windows reports them (and every access-time commit from a
 * plain Git read) as a change of `.git` itself. A `.git` file is a pointer whose content matters.
 * "missing" and "unreadable:<code>" say there is no entry to identify.
 */
export type ProjectGitEntryInspector = (rootPath: string) => string;

const inspectProjectGitEntry: ProjectGitEntryInspector = (rootPath) => {
  try {
    // Exact integers: a Windows file id exceeds 2^53, where neighbouring ids round to one number.
    const stats = lstatSync(join(rootPath, ".git"), { bigint: true });
    if (stats.isDirectory()) return `directory:${stats.ino}:${stats.birthtimeNs}`;
    const kind = stats.isFile() ? "file" : "other";
    return `${kind}:${stats.ino}:${stats.birthtimeNs}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.size}`;
  } catch (error) {
    if (isMissingPathError(error)) return "missing";
    const code =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    return `unreadable:${code}`;
  }
};

function isGitEntryPresent(entry: string | null): boolean {
  return entry !== null && entry !== "missing" && !entry.startsWith("unreadable:");
}

export type ReconciliationChange =
  | { kind: "workspace_archived"; workspaceId: string; directory: string; reason: string }
  | {
      kind: "project_updated";
      projectId: string;
      directory: string;
      fields: Partial<Pick<PersistedProjectRecord, "kind" | "projectKey">>;
    }
  | {
      kind: "workspace_updated";
      workspaceId: string;
      directory: string;
      fields: Partial<MutableWorkspacePlacement>;
    };

export interface ReconciliationResult {
  changesApplied: ReconciliationChange[];
  durationMs: number;
}

export interface WorkspaceReconciliationServiceOptions {
  serverId?: string;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  logger: pino.Logger;
  onChanges?: (changes: ReconciliationChange[]) => void;
  workspaceGitService?: Pick<WorkspaceGitService, "getCheckout">;
  onProjectUpdate?: (update: ProjectUpdate) => void;
  onWorkspaceArchived?: (workspaceId: string) => void | Promise<void>;
  onWorkspacesChanged?: (workspaceIds: string[]) => Promise<void>;
  watchProjectRoot?: ProjectRootWatch;
  inspectProjectGitEntry?: ProjectGitEntryInspector;
  clock?: ReconciliationClock;
  rescanIntervalMs?: number;
  debounceMs?: number;
}

interface ProjectReconciliationInput {
  project: PersistedProjectRecord;
  siblings: PersistedWorkspaceRecord[];
  currentGit: ProjectCheckoutLitePayload;
  readCheckout: (cwd: string) => Promise<ProjectCheckoutLitePayload>;
  changes: ReconciliationChange[];
}

interface CachedCheckoutRead {
  cwd: string;
  checkout: Promise<ProjectCheckoutLitePayload>;
}

type DirectoryState = "directory" | "missing" | "unreadable";

interface ProjectRootWatchTarget {
  rootPath: string;
  watcher: ProjectRootWatcher;
  /** What `.git` was when this watch last asked for a pass; null forces the next event through. */
  gitEntry: string | null;
  /** `.git` events dropped as unchanged since the last pass began. */
  filteredEvents: number;
}

// "watch" answers a change at a project root and "boot" converges a fresh daemon, so both read
// Git. "rescan" is the timer: it may take what a live repository watcher already knows.
type ReconciliationTrigger = "watch" | "rescan" | "boot";

export class WorkspaceReconciliationService {
  private readonly serverId: string | undefined;
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly logger: pino.Logger;
  private readonly onChanges: ((changes: ReconciliationChange[]) => void) | null;
  private readonly workspaceGitService: Pick<WorkspaceGitService, "getCheckout"> | null;
  private readonly onProjectUpdate: ((update: ProjectUpdate) => void) | null;
  private readonly onWorkspaceArchived: ((workspaceId: string) => void | Promise<void>) | null;
  private readonly onWorkspacesChanged: ((workspaceIds: string[]) => Promise<void>) | null;
  private readonly watchProjectRoot: ProjectRootWatch;
  private readonly inspectProjectGitEntry: ProjectGitEntryInspector;
  private readonly clock: ReconciliationClock;
  private readonly rescanIntervalMs: number;
  private readonly debounceMs: number;
  private readonly watchers: ProjectRootWatchTarget[] = [];
  private unsubscribeRegistry: (() => void) | null = null;
  private rescanTimer: ReconciliationTimer | null = null;
  private debounceTimer: ReconciliationTimer | null = null;
  private disposed = false;
  private started = false;
  private reconciling = false;
  private reconcileQueuedMode: "metadata" | "full" | null = null;

  constructor(options: WorkspaceReconciliationServiceOptions) {
    this.serverId = options.serverId;
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.logger = options.logger.child({ module: "workspace-reconciliation" });
    this.onChanges = options.onChanges ?? null;
    this.workspaceGitService = options.workspaceGitService ?? null;
    this.onProjectUpdate = options.onProjectUpdate ?? null;
    this.onWorkspaceArchived = options.onWorkspaceArchived ?? null;
    this.onWorkspacesChanged = options.onWorkspacesChanged ?? null;
    this.watchProjectRoot = options.watchProjectRoot ?? watchProjectRoot;
    this.inspectProjectGitEntry = options.inspectProjectGitEntry ?? inspectProjectGitEntry;
    this.clock = options.clock ?? systemClock;
    this.rescanIntervalMs = options.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribeRegistry =
      this.projectRegistry.subscribeToMutations?.(async (mutation) => {
        try {
          // Project creation does not resolve until its root watch is installed,
          // closing the git-init race for newly added empty projects.
          await this.syncProjectRootWatches();
          if (this.disposed) return;
          if (mutation.kind === "upsert" && mutation.project && !mutation.project.archivedAt) {
            this.onProjectUpdate?.({ kind: "upsert", project: mutation.project });
          } else {
            this.onProjectUpdate?.({ kind: "remove", projectId: mutation.projectId });
          }
        } catch (error) {
          this.logger.warn({ err: error }, "Project reconciliation mutation handling failed");
        }
      }) ?? null;
    await this.syncProjectRootWatches();
    this.rescanTimer = this.clock.setInterval(
      () => this.reconcileObservedGitMetadata("full", "rescan"),
      this.rescanIntervalMs,
    );
    this.rescanTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = null;
    if (this.rescanTimer) this.clock.clearInterval(this.rescanTimer);
    if (this.debounceTimer) this.clock.clearTimeout(this.debounceTimer);
    for (const { watcher } of this.watchers) watcher.close();
    this.watchers.length = 0;
  }

  /** Reconciles mutable Git facts only; never archives missing records. */
  async reconcileGitMetadata(
    checkoutRead?: WorkspaceGitCheckoutOptions,
  ): Promise<ReconciliationResult> {
    const start = Date.now();
    const changes: ReconciliationChange[] = [];
    const [projects, workspaces] = await Promise.all([
      this.projectRegistry.list(),
      this.workspaceRegistry.list(),
    ]);
    const workspacesByProject = new Map<string, PersistedWorkspaceRecord[]>();
    for (const workspace of workspaces) {
      if (workspace.archivedAt || this.inspectDirectory(workspace.cwd) !== "directory") continue;
      const siblings = workspacesByProject.get(workspace.projectId) ?? [];
      siblings.push(workspace);
      workspacesByProject.set(workspace.projectId, siblings);
    }
    await this.reconcileGitMetadataForProjects(
      projects.filter(
        (project) => !project.archivedAt && this.inspectDirectory(project.rootPath) === "directory",
      ),
      workspacesByProject,
      changes,
      checkoutRead,
    );
    if (changes.length > 0) this.onChanges?.(changes);
    return { changesApplied: changes, durationMs: Date.now() - start };
  }

  async runOnce(checkoutRead?: WorkspaceGitCheckoutOptions): Promise<ReconciliationResult> {
    const start = Date.now();
    const changes: ReconciliationChange[] = [];

    const allProjects = await this.projectRegistry.list();
    const allWorkspaces = await this.workspaceRegistry.list();

    const activeProjects = allProjects.filter((p) => !p.archivedAt);
    const activeWorkspaces = allWorkspaces.filter((w) => !w.archivedAt);
    const workspaceDirectoryStates = activeWorkspaces.map((workspace) => ({
      workspace,
      state: this.inspectDirectory(workspace.cwd),
    }));
    // Project roots are read after the workspace directories, so a volume that
    // goes away mid-pass leaves its project unreachable rather than its workspaces
    // alone. The skew can only withhold an archive, never produce one.
    const reachableProjectIds = new Set(
      activeProjects
        .filter((project) => this.inspectDirectory(project.rootPath) === "directory")
        .map((project) => project.projectId),
    );

    const workspacesByProject = new Map<string, PersistedWorkspaceRecord[]>();
    for (const { workspace, state } of workspaceDirectoryStates) {
      if (state !== "directory") continue;
      const list = workspacesByProject.get(workspace.projectId) ?? [];
      list.push(workspace);
      workspacesByProject.set(workspace.projectId, list);
    }

    // 1. Archive workspaces whose directories no longer exist, but only when the
    //    project they belong to is still reachable. A missing project root means the
    //    whole location is unavailable - an unmounted volume, an offline share, a disk
    //    that has not appeared yet - and absence there proves nothing about the
    //    workspace. Projects already persist through that; their workspaces do too.
    const missingWorkspaces = workspaceDirectoryStates
      .filter(
        ({ workspace, state }) =>
          state === "missing" && reachableProjectIds.has(workspace.projectId),
      )
      .map(({ workspace }) => workspace);
    await Promise.all(
      missingWorkspaces.map(async (workspace) => {
        const timestamp = new Date().toISOString();
        await this.workspaceRegistry.archive(workspace.workspaceId, timestamp);
        await this.onWorkspaceArchived?.(workspace.workspaceId);
        changes.push({
          kind: "workspace_archived",
          workspaceId: workspace.workspaceId,
          directory: workspace.cwd,
          reason: "directory_missing",
        });

        // Update the in-memory list for the project orphan check below
        const siblings = workspacesByProject.get(workspace.projectId);
        if (siblings) {
          const updated = siblings.filter((w) => w.workspaceId !== workspace.workspaceId);
          workspacesByProject.set(workspace.projectId, updated);
        }
      }),
    );

    // 2. Reconcile mutable git metadata without changing identity or membership.
    //    Projects persist until explicitly removed, even when they currently have
    //    zero active workspaces, so they still reconcile their own metadata.
    await this.reconcileGitMetadataForProjects(
      activeProjects.filter((project) => reachableProjectIds.has(project.projectId)),
      workspacesByProject,
      changes,
      checkoutRead,
    );

    if (changes.length > 0 && this.onChanges) {
      this.onChanges(changes);
    }

    const result = { changesApplied: changes, durationMs: Date.now() - start };
    if (changes.length > 0) {
      this.logger.info(
        { changeCount: changes.length, durationMs: result.durationMs, changes },
        "Workspace reconciliation applied changes",
      );
    }
    return result;
  }

  /** Runs the boot-time convergence path and publishes every affected workspace. */
  async reconcileNow(): Promise<void> {
    await this.reconcileObservedGitMetadata("full", "boot");
  }

  private async reconcileGitMetadataForProjects(
    projectsToReconcile: PersistedProjectRecord[],
    workspacesByProject: Map<string, PersistedWorkspaceRecord[]>,
    changes: ReconciliationChange[],
    checkoutRead?: WorkspaceGitCheckoutOptions,
  ): Promise<void> {
    const checkoutReads: CachedCheckoutRead[] = [];
    const readCheckout = (cwd: string): Promise<ProjectCheckoutLitePayload> => {
      const existing = checkoutReads.find((read) => areEquivalentPaths(read.cwd, cwd));
      if (existing) return existing.checkout;
      const checkout = this.readCheckout(cwd, checkoutRead);
      checkoutReads.push({ cwd, checkout });
      return checkout;
    };
    const roots: Array<{ rootPath: string; projects: PersistedProjectRecord[] }> = [];
    for (const project of projectsToReconcile) {
      const root = roots.find((candidate) =>
        areEquivalentPaths(candidate.rootPath, project.rootPath),
      );
      if (root) root.projects.push(project);
      else roots.push({ rootPath: project.rootPath, projects: [project] });
    }
    await Promise.all(
      roots.map(async ({ rootPath, projects }) => {
        try {
          const rootGit = await readCheckout(rootPath);
          if (!rootGit.isGit) {
            // The Git probe reports a repository caught mid-creation (`git init`, a clone) as no
            // repository rather than failing. With `.git` already there, later events inside it
            // would compare equal and be dropped, so the next one has to get through.
            this.forgetGitEntries(rootPath, isGitEntryPresent);
          }
          await Promise.all(
            projects.map((project) =>
              this.reconcileProject({
                project,
                siblings: workspacesByProject.get(project.projectId) ?? [],
                currentGit: rootGit,
                readCheckout,
                changes,
              }),
            ),
          );
        } catch (error) {
          // Nothing was learned about this root; its next event has to get through.
          this.forgetGitEntries(rootPath);
          this.logger.warn(
            { err: error, rootPath },
            "Skipped workspace reconciliation after Git read failed",
          );
        }
      }),
    );
  }

  private async reconcileProject(input: ProjectReconciliationInput): Promise<void> {
    const { project, siblings, currentGit, readCheckout, changes } = input;
    const workspaceCheckouts = await Promise.all(
      siblings.map(async (workspace) => ({
        workspace,
        checkout: await readCheckout(workspace.cwd),
      })),
    );
    const projectUpdates: Partial<Pick<PersistedProjectRecord, "kind" | "projectKey">> = {};
    const mappedKind = deriveProjectKind(currentGit);
    const projectKey = deriveProjectKey({
      rootPath: project.rootPath,
      remoteUrl: currentGit.remoteUrl,
      worktreeRoot: currentGit.worktreeRoot,
      mainRepoRoot: currentGit.mainRepoRoot,
      serverId: this.serverId,
    });

    if (project.kind !== mappedKind) {
      projectUpdates.kind = mappedKind;
    }
    if (project.projectKey !== projectKey) {
      projectUpdates.projectKey = projectKey;
    }

    if (Object.keys(projectUpdates).length > 0) {
      const timestamp = new Date().toISOString();
      await this.projectRegistry.upsert({
        ...project,
        ...projectUpdates,
        updatedAt: timestamp,
      });
      changes.push({
        kind: "project_updated",
        projectId: project.projectId,
        directory: project.rootPath,
        fields: projectUpdates,
      });
    }

    await Promise.all(
      workspaceCheckouts.map(async ({ workspace, checkout: wsGit }) => {
        const timestamp = new Date().toISOString();
        const update = reconcileWorkspacePlacement({
          workspace,
          checkout: wsGit,
          updatedAt: timestamp,
        });
        if (!update) return;

        const updated = await this.workspaceRegistry.update(workspace.workspaceId, (current) => ({
          ...current,
          ...update.fields,
          updatedAt: timestamp,
        }));
        if (!updated) return;
        changes.push({
          kind: "workspace_updated",
          workspaceId: workspace.workspaceId,
          directory: workspace.cwd,
          fields: update.fields,
        });
      }),
    );
  }

  private async syncProjectRootWatches(): Promise<void> {
    if (this.disposed) return;
    const projects = await this.projectRegistry.list();
    if (this.disposed) return;
    const activeProjects = projects.filter((project) => !project.archivedAt);

    for (let index = this.watchers.length - 1; index >= 0; index -= 1) {
      const target = this.watchers[index]!;
      const stillActive = activeProjects.some((project) =>
        areEquivalentPaths(project.rootPath, target.rootPath),
      );
      if (stillActive) continue;
      target.watcher.close();
      this.watchers.splice(index, 1);
    }

    for (const project of activeProjects) {
      const alreadyWatching = this.watchers.some((target) =>
        areEquivalentPaths(target.rootPath, project.rootPath),
      );
      if (alreadyWatching) continue;
      try {
        // Read before the watch exists: a `.git` that appears in between raises an event that
        // compares against the earlier state instead of being taken as already seen.
        const gitEntry = this.inspectProjectGitEntry(project.rootPath);
        let target: ProjectRootWatchTarget | null = null;
        const watcher = this.watchProjectRoot(
          project.rootPath,
          { recursive: false },
          (event, filename) => {
            if (filename !== null && filename.toString() !== ".git") return;
            // Only a change is filtered: access-time commits and writes inside `.git` raise
            // nothing else. A rename says the entry appeared, vanished, or was replaced, and a
            // recreated directory can come back with a reused inode and no birth time to tell.
            const mustPass = filename === null || event !== "change";
            if (target && !this.noteGitEntry(target, mustPass)) return;
            this.scheduleObservedReconciliation();
          },
          (error) => {
            watcher.close();
            const index = this.watchers.findIndex((candidate) => candidate.watcher === watcher);
            if (index >= 0) this.watchers.splice(index, 1);
            this.logger.warn(
              { err: error, rootPath: project.rootPath },
              "Project root watch failed",
            );
          },
        );
        target = { rootPath: project.rootPath, watcher, gitEntry, filteredEvents: 0 };
        this.watchers.push(target);
      } catch (error) {
        // The periodic reconciliation is the convergence path for roots that
        // are temporarily missing or unwatchable.
        this.logger.debug(
          { err: error, rootPath: project.rootPath },
          "Project root is not watchable yet",
        );
      }
    }
  }

  /** Records what `.git` is now and answers whether that warrants a pass. */
  private noteGitEntry(target: ProjectRootWatchTarget, mustPass: boolean): boolean {
    const next = this.inspectProjectGitEntry(target.rootPath);
    const moved = mustPass || target.gitEntry === null || next !== target.gitEntry;
    target.gitEntry = next;
    if (!moved) target.filteredEvents += 1;
    return moved;
  }

  /** Takes, per watched root, the `.git` events dropped since the last pass began. */
  private takeFilteredGitEvents(): Array<{ rootPath: string; filteredEvents: number }> {
    const taken: Array<{ rootPath: string; filteredEvents: number }> = [];
    for (const target of this.watchers) {
      if (target.filteredEvents === 0) continue;
      taken.push({ rootPath: target.rootPath, filteredEvents: target.filteredEvents });
      target.filteredEvents = 0;
    }
    return taken;
  }

  /**
   * Leaves a trace when a pass changes a root whose watch dropped `.git` events as unchanged since
   * the pass before: the filter may have held that change back until now. Expected for a branch
   * switched at a root on Windows, which the rescan picks up; anything else points at the filter.
   */
  private reportFilteredGitEvents(
    trigger: ReconciliationTrigger,
    filtered: Array<{ rootPath: string; filteredEvents: number }>,
    changes: ReconciliationChange[],
  ): void {
    const roots = filtered.flatMap((root) => {
      const rootChanges = changes.filter((change) =>
        areEquivalentPaths(change.directory, root.rootPath),
      );
      return rootChanges.length > 0 ? [{ ...root, changes: rootChanges }] : [];
    });
    if (roots.length === 0) return;
    this.logger.info(
      { trigger, roots },
      "Workspace reconciliation changed roots whose watch filtered .git events",
    );
  }

  /** Lets the next `.git` event of the matching watches through, whatever it compares to. */
  private forgetGitEntries(
    rootPath?: string,
    when: (entry: string | null) => boolean = () => true,
  ): void {
    for (const target of this.watchers) {
      if (rootPath !== undefined && !areEquivalentPaths(target.rootPath, rootPath)) continue;
      if (when(target.gitEntry)) target.gitEntry = null;
    }
  }

  private scheduleObservedReconciliation(): void {
    if (this.disposed || this.debounceTimer) return;
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = null;
      return this.reconcileObservedGitMetadata();
    }, this.debounceMs);
  }

  private async reconcileObservedGitMetadata(
    mode: "metadata" | "full" = "metadata",
    trigger: ReconciliationTrigger = "watch",
  ): Promise<void> {
    if (this.disposed) return;
    if (this.reconciling) {
      if (mode === "full" || this.reconcileQueuedMode === null) {
        this.reconcileQueuedMode = mode;
      }
      return;
    }
    this.reconciling = true;
    try {
      await this.syncProjectRootWatches();
      const filteredGitEvents = this.takeFilteredGitEvents();
      const checkoutRead: WorkspaceGitCheckoutOptions = {
        allowObserved: trigger === "rescan",
        reason: `reconcile-${trigger}`,
      };
      const result =
        mode === "full"
          ? await this.runOnce(checkoutRead)
          : await this.reconcileGitMetadata(checkoutRead);
      this.reportFilteredGitEvents(trigger, filteredGitEvents, result.changesApplied);
      const workspaceIds = new Set<string>();
      const projectIds = new Set<string>();
      for (const change of result.changesApplied) {
        if (change.kind === "workspace_updated" || change.kind === "workspace_archived") {
          workspaceIds.add(change.workspaceId);
        }
        if (change.kind === "project_updated") projectIds.add(change.projectId);
      }
      if (projectIds.size > 0) {
        const workspaces = await this.workspaceRegistry.list();
        for (const workspaceId of workspaceIdsForProjects(workspaces, projectIds)) {
          workspaceIds.add(workspaceId);
        }
      }
      if (!this.disposed && workspaceIds.size > 0) {
        await this.onWorkspacesChanged?.(Array.from(workspaceIds));
      }
    } catch (error) {
      // The pass did not converge on what the root watches last saw; let the next event through.
      this.forgetGitEntries();
      if (!this.disposed) {
        this.logger.warn({ err: error }, "Workspace reconciliation failed");
      }
    } finally {
      this.reconciling = false;
      if (this.reconcileQueuedMode) {
        const queuedMode = this.reconcileQueuedMode;
        this.reconcileQueuedMode = null;
        void this.reconcileObservedGitMetadata(queuedMode);
      }
    }
  }

  private async readCheckout(
    cwd: string,
    checkoutRead?: WorkspaceGitCheckoutOptions,
  ): Promise<ProjectCheckoutLitePayload> {
    if (!this.workspaceGitService) {
      return {
        cwd,
        isGit: false as const,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false as const,
        mainRepoRoot: null,
      };
    }
    return this.workspaceGitService.getCheckout(cwd, checkoutRead);
  }

  private inspectDirectory(targetPath: string): DirectoryState {
    try {
      return statSync(targetPath).isDirectory() ? "directory" : "missing";
    } catch (error) {
      if (isMissingPathError(error)) return "missing";
      this.logger.warn(
        { err: error, targetPath },
        "Skipped workspace reconciliation after directory inspection failed",
      );
      return "unreadable";
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}
