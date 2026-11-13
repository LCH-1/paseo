import { type Dirent, type Stats, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BackendDiagnostics, ObservationBackend, ObservationHost } from "./contracts.js";
import type { ObserverPaths } from "./paths.js";
import { isMissingPathError, toError } from "./paths.js";

const MAX_TRACKED_ENTRIES = 250_000;
// fs.stat runs on the libuv threadpool, which is four threads and shared by the
// whole daemon. One stat per native event pins it and unrelated filesystem work
// stalls. Beyond the queue bound, fall back to a directory scan, which finds the
// same paths at a fraction of the cost.
const MAX_CONCURRENT_CLASSIFICATIONS = 32;
const MAX_QUEUED_CLASSIFICATIONS = 2_048;
const AUDIT_QUIET_MS = 500;
const AUDIT_MAX_DIRTY_MS = 5_000;
const OPTIONAL_AUDIT_QUIET_MS = 8_000;
const OPTIONAL_AUDIT_MAX_DIRTY_MS = 8_000;
const FULL_AUDIT_QUIET_MS = 30_000;
const FULL_AUDIT_MIN_INTERVAL_MS = 30_000;
const FULL_AUDIT_MAX_DIRTY_MS = 5 * 60_000;
// Windows reports a last-access time update as a change. NTFS commits access
// times at most once an hour per entry, so merely reading a file or listing a
// directory announces a change that changed nothing, and each one fanned out
// into Git refreshes and audits. A change whose stat signature matches the one
// already announced is dropped. A signature taken within this window of its
// own modification is not trusted: another write in the same timestamp tick
// would leave it identical (the racy case Git handles the same way).
const CHANGE_SIGNATURE_RACY_WINDOW_MS = 3_000;
// Bounds memory per watched root, least recently reported first. An entry costs about 700 bytes
// with Windows paths (the joined path string dominates), so a full root holds about 0.7 MB; every
// watched working tree and Git directory has its own. The paths that keep reporting (Git metadata,
// files an agent keeps rereading) stay; an evicted path costs one extra announced change.
const MAX_CHANGE_SIGNATURES = 1_024;

interface DirectoryEntry {
  directories: Set<string>;
  files: Set<string>;
}

interface Inventory {
  directories: Set<string>;
  entries: Map<string, DirectoryEntry>;
  files: Set<string>;
}

type WatchDirectory = (
  root: string,
  listener: (eventType: string, filename: string | null) => void,
) => {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
};

const watchDirectory: WatchDirectory = (root, listener) =>
  watch(root, { recursive: true }, listener);

export interface NativeRecursiveOptions {
  /**
   * Drop a change on a known path whose stat signature has not moved since the
   * last event announced for it. On by default on Windows, where access-time
   * updates arrive as changes; FSEvents does not report them.
   */
  filterUnchangedChanges?: boolean;
  /** Decides the filter's default; the platform the daemon runs on unless a test says otherwise. */
  platform?: NodeJS.Platform;
  maxChangeSignatures?: number;
  now?: () => number;
}

interface ChangeSignature {
  value: string;
  racy: boolean;
}

interface StatJob {
  path: string;
  run: () => Promise<void>;
}

export function createNativeRecursiveBackend(
  host: ObservationHost,
  paths: ObserverPaths,
  observe: WatchDirectory = watchDirectory,
  options: NativeRecursiveOptions = {},
): ObservationBackend {
  return new NativeRecursiveBackend(host, paths, observe, options);
}

class NativeRecursiveBackend implements ObservationBackend {
  private watcher: ReturnType<WatchDirectory> | null = null;
  private files = new Set<string>();
  // Files classified before their parent directory has an entries bucket.
  // walkSubtree can only reach files through that bucket, so these stay
  // tracked directly until a scoped audit builds the bucket and adopts them.
  // Bounded by every file classified within one full-audit window (up to
  // FULL_AUDIT_MAX_DIRTY_MS, 5 minutes) whose parent never got a bucket, not
  // by the size of the tracked set.
  private orphanFiles = new Set<string>();
  private directories = new Set<string>();
  private entries = new Map<string, DirectoryEntry>();
  private readonly classifications = new Set<Promise<void>>();
  private readonly classificationQueue: StatJob[] = [];
  // Last stat signature announced to consumers per path. Entries for deleted
  // paths are harmless: a recreated file has a new identity and change time.
  private readonly changeSignatures = new Map<string, ChangeSignature>();
  private readonly filterUnchangedChanges: boolean;
  private readonly maxChangeSignatures: number;
  private readonly now: () => number;
  private readonly localScopes = new Set<string>();
  private readonly changeScopes = new Set<string>();
  private readonly recursiveScopes = new Set<string>();
  private reconcileTail: Promise<void> = Promise.resolve();
  private queueDepth = 0;
  private inFlight = false;
  private auditTimer: NodeJS.Timeout | null = null;
  private fullAuditTimer: NodeJS.Timeout | null = null;
  private fullAuditRequested = false;
  private auditDirty = false;
  private auditDirtySince: number | null = null;
  private auditLastDirtyAt: number | null = null;
  private auditQueued = false;
  private auditRunning = false;
  private safetyAuditPending = false;
  private safetyAuditDirtySince: number | null = null;
  private safetyAuditLastDirtyAt: number | null = null;
  private lastFullAuditAt = Number.NEGATIVE_INFINITY;
  private generation = 0;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly host: ObservationHost,
    private readonly paths: ObserverPaths,
    private readonly observe: WatchDirectory,
    options: NativeRecursiveOptions,
  ) {
    this.filterUnchangedChanges =
      options.filterUnchangedChanges ?? (options.platform ?? process.platform) === "win32";
    this.maxChangeSignatures = options.maxChangeSignatures ?? MAX_CHANGE_SIGNATURES;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    this.watchRoot();
    this.fullAuditRequested = true;
    this.auditQueued = true;
    await this.enqueueAudit(false, this.generation);
  }

  async updateIgnore(): Promise<void> {
    this.discardIgnoredClassifications();
    const inFlight = [...this.classifications];
    this.generation += 1;
    this.cancelAudits();
    this.fullAuditRequested = true;
    this.auditQueued = true;
    await this.enqueueAudit(true, this.generation);
    await Promise.allSettled(inFlight);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.cancelAudits();
    this.watcher?.close();
    this.watcher = null;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  getDiagnostics(): BackendDiagnostics {
    return {
      nativeHandleCount: this.watcher ? 1 : 0,
      nativeTrackedFileCount: this.files.size,
      pendingReconciliationWorkCount:
        this.localScopes.size +
        this.changeScopes.size +
        this.recursiveScopes.size +
        this.classifications.size +
        this.classificationQueue.length +
        this.queueDepth +
        Number(this.auditTimer !== null || this.auditQueued || this.auditDirty),
      pendingClassificationCount: this.classifications.size + this.classificationQueue.length,
      reconciliationInFlight: this.inFlight,
    };
  }

  private async finishClose(): Promise<void> {
    await this.reconcileTail;
    this.classificationQueue.length = 0;
    await Promise.allSettled(this.classifications);
    this.watcher?.close();
    this.watcher = null;
    this.files.clear();
    this.orphanFiles.clear();
    this.directories.clear();
    this.entries.clear();
    this.changeSignatures.clear();
  }

  private watchRoot(): void {
    const watcher = this.observe(this.host.root, (eventType, filename) => {
      if (!this.host.isActive()) return;
      this.host.metrics.nativeEventCount += 1;
      if (!filename) {
        this.host.metrics.nativePathlessEventCount += 1;
        this.host.queueEvent("update", this.host.root);
        this.requestAudit(this.host.root);
        return;
      }
      const path = resolve(this.host.root, filename.toString());
      if (this.host.isIgnored(path)) return;
      const scope = path === this.host.root ? this.host.root : dirname(path);
      const knownDirectory = this.directories.has(path);
      if (eventType === "change") {
        this.host.metrics.nativeChangeEventCount += 1;
        if (knownDirectory || this.files.has(path)) {
          if (this.filterUnchangedChanges) this.verifyChange(path, scope, knownDirectory);
          else this.acceptChange(path, scope, knownDirectory);
          return;
        }
        // A coalesced creation can arrive only as a change. Classify unknown
        // paths so later deletion scans can find them in the inventory.
        this.requestChangeAudit(scope);
        this.host.queueEvent("update", path);
      } else {
        this.requestChangeAudit(scope);
        this.host.metrics.nativeRenameEventCount += 1;
        if (knownDirectory) this.requestAudit(scope);
      }
      this.classify(path, (isDirectory) => {
        if (!isDirectory) {
          const entry = this.entries.get(scope);
          if (entry) {
            // Remember files as soon as we announce them. A coalesced delete must
            // still be found by the next audit, even before the first directory scan.
            this.files.add(path);
            entry.files.add(path);
          } else {
            // No inventory for the parent yet. runClassification already
            // announced this as a create, so it must stay findable for a
            // matching delete: track it directly until a scoped audit builds
            // the bucket and adopts it (see orphanFiles above).
            this.files.add(path);
            this.orphanFiles.add(path);
            this.requestAudit(scope);
          }
          return;
        }
        if (knownDirectory) this.requestAudit(path, true);
        else this.requestAudit(scope);
      });
    });
    watcher.on("error", (error) => {
      if (this.host.isActive()) this.host.fail(toError(error));
    });
    this.watcher = watcher;
  }

  private enqueueAudit(emitDiff: boolean, generation: number): Promise<void> {
    this.queueDepth += 1;
    const result = this.reconcileTail
      .then(() => this.runAudit(emitDiff, generation))
      .finally(() => {
        this.queueDepth -= 1;
      });
    this.reconcileTail = result.catch(() => undefined);
    return result;
  }

  private async runAudit(emitDiff: boolean, generation: number): Promise<void> {
    this.auditQueued = false;
    if (!this.canCommit(generation)) return;
    const fullAudit = this.fullAuditRequested;
    const localScopes = [...this.localScopes];
    const changeScopes = [...this.changeScopes];
    const recursiveScopes = [...this.recursiveScopes];
    this.fullAuditRequested = false;
    this.localScopes.clear();
    this.changeScopes.clear();
    this.recursiveScopes.clear();
    if (fullAudit) this.clearSafetyAudit();
    this.auditRunning = true;
    this.auditDirty = false;
    this.auditDirtySince = null;
    this.auditLastDirtyAt = null;
    this.inFlight = true;
    const startedAt = performance.now();
    try {
      if (fullAudit) {
        const next = await this.scanTree(this.host.root);
        if (!this.canCommit(generation)) return;
        if (emitDiff) {
          this.queueDiff(next.files, this.files);
          this.queueRemovedDirectories(next.directories, this.directories);
        }
        this.replaceInventory(next);
        this.lastFullAuditAt = performance.now();
        this.host.metrics.fullReconciliationCount += 1;
      } else {
        await this.reconcileScopes(localScopes, changeScopes, recursiveScopes, generation);
        this.host.metrics.scopedReconciliationCount += 1;
      }
    } catch (error) {
      this.host.metrics.reconciliationFailureCount += 1;
      throw error;
    } finally {
      const durationMs = performance.now() - startedAt;
      this.host.metrics.reconciliationCount += 1;
      this.host.metrics.lastReconciliationDurationMs = durationMs;
      this.host.metrics.maxReconciliationDurationMs = Math.max(
        this.host.metrics.maxReconciliationDurationMs,
        durationMs,
      );
      this.inFlight = false;
      this.auditRunning = false;
      if (this.safetyAuditPending && this.host.isActive()) this.scheduleFullAudit();
      if (this.auditDirty && this.host.isActive()) this.scheduleAudit();
    }
  }

  private async scanTree(root: string): Promise<Inventory> {
    const files = new Set<string>();
    const directories = new Set<string>();
    const entries = new Map<string, DirectoryEntry>();
    const pending = [root];
    while (pending.length > 0 && this.host.isActive()) {
      const directory = pending.pop();
      if (!directory) continue;
      let children: Dirent[];
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isMissingPathError(error) && !this.host.isActive()) {
          return { directories, entries, files };
        }
        if (!isMissingPathError(error) || directory === this.host.root) throw error;
        continue;
      }
      directories.add(directory);
      this.assertWithinLimit(files.size + directories.size);
      const entry: DirectoryEntry = { directories: new Set(), files: new Set() };
      for (const child of children) {
        const path = join(directory, child.name);
        if (this.host.isIgnored(path)) continue;
        if (child.isDirectory()) {
          entry.directories.add(path);
          pending.push(path);
        } else {
          entry.files.add(path);
          files.add(path);
          this.assertWithinLimit(files.size + directories.size);
        }
      }
      entries.set(directory, entry);
    }
    return { directories, entries, files };
  }

  private async reconcileScopes(
    localScopes: string[],
    changeScopes: string[],
    recursiveScopes: string[],
    generation: number,
  ): Promise<void> {
    const forcedLocalScopes = new Set(localScopes);
    const forcedRecursiveScopes = this.paths.collapse(recursiveScopes);
    for (const directory of new Set(localScopes)) {
      await this.reconcileDirectory(directory, generation);
      if (!this.canCommit(generation)) return;
      await new Promise<void>((done) => setImmediate(done));
    }
    for (const directory of new Set(recursiveScopes)) {
      await this.reconcileSubtree(directory, generation);
      if (!this.canCommit(generation)) return;
      await new Promise<void>((done) => setImmediate(done));
    }
    // Parent scans are shallow, so a queued parent cannot cover its children.
    for (const directory of new Set(changeScopes)) {
      const alreadyCovered =
        forcedLocalScopes.has(directory) ||
        forcedRecursiveScopes.some((scope) => this.host.isPathInside(scope, directory));
      if (alreadyCovered) continue;
      await this.reconcileDirectory(directory, generation);
      if (!this.canCommit(generation)) return;
      await new Promise<void>((done) => setImmediate(done));
    }
  }

  private async reconcileDirectory(directory: string, generation: number): Promise<void> {
    if (this.host.isIgnored(directory)) {
      this.removeSubtree(directory, false);
      return;
    }
    if (directory !== this.host.root && !this.directories.has(directory)) {
      await this.reconcileUnknownSubtree(directory, generation);
      return;
    }
    const next = await this.readDirectory(directory);
    if (!this.canCommit(generation)) return;
    if (!next) {
      this.removeSubtree(directory, true);
      return;
    }
    const previous = this.entries.get(directory) ?? {
      directories: new Set<string>(),
      files: new Set<string>(),
    };
    for (const path of previous.files) {
      if (!next.files.has(path)) {
        this.files.delete(path);
        this.host.queueEvent("delete", path);
      }
    }
    for (const path of previous.directories) {
      if (!next.directories.has(path)) this.removeSubtree(path, true);
    }
    for (const path of next.files) {
      this.orphanFiles.delete(path);
      if (!previous.files.has(path)) {
        this.files.add(path);
        this.host.queueEvent("create", path);
      }
    }
    for (const path of next.directories) {
      if (previous.directories.has(path)) continue;
      const inventory = await this.scanTree(path);
      if (!this.canCommit(generation)) return;
      if (!inventory.directories.has(path)) {
        next.directories.delete(path);
        continue;
      }
      this.mergeInventory(inventory, true);
    }
    this.directories.add(directory);
    this.entries.set(directory, next);
    this.assertWithinLimit(this.files.size + this.directories.size);
  }

  private async reconcileUnknownSubtree(directory: string, generation: number): Promise<void> {
    const inventory = await this.scanTree(directory);
    if (!this.canCommit(generation)) return;
    if (!inventory.directories.has(directory)) {
      this.removeSubtree(directory, true);
      return;
    }
    this.entries.get(dirname(directory))?.directories.add(directory);
    this.mergeInventory(inventory, true);
  }

  private async readDirectory(directory: string): Promise<DirectoryEntry | null> {
    this.host.metrics.nativeShallowScanCount += 1;
    let children: Dirent[];
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!isMissingPathError(error) || directory === this.host.root) throw error;
      return null;
    }
    const entry: DirectoryEntry = { directories: new Set(), files: new Set() };
    for (const child of children) {
      const path = join(directory, child.name);
      if (this.host.isIgnored(path)) continue;
      if (child.isDirectory()) entry.directories.add(path);
      else entry.files.add(path);
    }
    return entry;
  }

  private async reconcileSubtree(directory: string, generation: number): Promise<void> {
    if (!this.directories.has(directory) || this.host.isIgnored(directory)) return;
    const inventory = await this.scanTree(directory);
    if (!this.canCommit(generation)) return;
    const previousFiles = new Set<string>();
    for (const tracked of this.walkSubtree(directory)) {
      const entry = this.entries.get(tracked);
      if (!entry) continue;
      for (const file of entry.files) previousFiles.add(file);
    }
    this.queueDiff(inventory.files, previousFiles);
    this.queueRemovedDirectories(inventory.directories, this.walkSubtree(directory));
    this.removeSubtree(directory, false);
    // removeSubtree unlinks `directory` from its own parent's directories set
    // as part of tearing down the old subtree. Mirror reconcileUnknownSubtree
    // and re-link it, guarded on the directory still existing -- it can
    // vanish between the `this.directories.has` check above and this scan --
    // or walkSubtree can no longer reach anything under it from the root.
    if (inventory.directories.has(directory)) {
      this.entries.get(dirname(directory))?.directories.add(directory);
    }
    this.mergeInventory(inventory, false);
  }

  private queueDiff(nextFiles: Set<string>, previousFiles: Set<string>): void {
    for (const path of nextFiles) {
      if (!previousFiles.has(path)) this.host.queueEvent("create", path);
    }
    for (const path of previousFiles) {
      if (!nextFiles.has(path)) this.host.queueEvent("delete", path);
    }
  }

  private queueRemovedDirectories(next: Set<string>, previous: Iterable<string>): void {
    for (const directory of previous) {
      if (!next.has(directory)) this.host.queueEvent("delete", directory);
    }
  }

  private replaceInventory(inventory: Inventory): void {
    this.files = inventory.files;
    // A full scan gives every existing file a directory-index home.
    this.orphanFiles.clear();
    this.directories = inventory.directories;
    this.entries = inventory.entries;
  }

  private mergeInventory(inventory: Inventory, emitCreates: boolean): void {
    for (const directory of inventory.directories) this.directories.add(directory);
    for (const [directory, entry] of inventory.entries) this.entries.set(directory, entry);
    for (const path of inventory.files) {
      this.orphanFiles.delete(path);
      const added = !this.files.has(path);
      this.files.add(path);
      if (emitCreates && added) this.host.queueEvent("create", path);
    }
    this.assertWithinLimit(this.files.size + this.directories.size);
  }

  // Depends on the invariant that every tracked directory has an `entries`
  // bucket, and that `this.directories` and `this.entries` are written and
  // cleared together. A root with no bucket yields nothing here, which makes
  // `removeSubtree` a near no-op for that root — it deletes nothing from
  // `entries`/`directories` and only cleans up matching `orphanFiles` — so
  // nothing enforces the invariant beyond this comment.
  private *walkSubtree(root: string): Generator<string> {
    const stack = [root];
    while (stack.length > 0) {
      const directory = stack.pop();
      if (directory === undefined) continue;
      const entry = this.entries.get(directory);
      if (!entry) continue;
      yield directory;
      for (const child of entry.directories) stack.push(child);
    }
  }

  private removeSubtree(root: string, emitDeletes: boolean): void {
    for (const directory of this.walkSubtree(root)) {
      const entry = this.entries.get(directory);
      if (entry) {
        for (const file of entry.files) {
          if (!this.files.delete(file)) continue;
          if (emitDeletes) this.host.queueEvent("delete", file);
        }
        // A native rename can name only a deleted file. The scoped scan still
        // knows its parent disappeared, so report that topology change too.
        if (emitDeletes) this.host.queueEvent("delete", directory);
      }
      this.entries.delete(directory);
      this.directories.delete(directory);
    }
    // Orphaned files have no directory-index home, so walkSubtree cannot
    // find them. This set is bounded by every file classified within one
    // full-audit window (up to FULL_AUDIT_MAX_DIRTY_MS, 5 minutes) whose
    // parent never got a bucket, not by the tracked-set size.
    for (const path of this.orphanFiles) {
      if (!this.host.isPathInside(root, path)) continue;
      this.orphanFiles.delete(path);
      if (this.files.delete(path) && emitDeletes) this.host.queueEvent("delete", path);
    }
    // `root` can be a tracked file rather than a directory.
    if (this.files.delete(root) && emitDeletes) this.host.queueEvent("delete", root);
    const parent = this.entries.get(dirname(root));
    parent?.directories.delete(root);
    parent?.files.delete(root);
  }

  private requestAudit(scope: string, recursive = false): void {
    if (!this.host.isActive()) return;
    if (recursive) this.recursiveScopes.add(scope);
    else this.localScopes.add(scope);
    this.markAuditDirty();
  }

  private requestChangeAudit(scope: string): void {
    if (!this.host.isActive()) return;
    this.changeScopes.add(scope);
    this.markAuditDirty();
  }

  private markAuditDirty(): void {
    this.requestSafetyAudit();
    const now = performance.now();
    this.auditDirty = true;
    this.auditDirtySince ??= now;
    this.auditLastDirtyAt = now;
    if (this.auditQueued || this.auditRunning) return;
    if (this.auditTimer) clearTimeout(this.auditTimer);
    this.auditTimer = null;
    this.scheduleAudit();
  }

  private scheduleAudit(): void {
    if (
      !this.host.isActive() ||
      !this.auditDirty ||
      this.auditQueued ||
      this.auditRunning ||
      this.auditTimer
    ) {
      return;
    }
    const now = performance.now();
    const optionalOnly = this.isOptionalOnly();
    const quietMs = optionalOnly ? OPTIONAL_AUDIT_QUIET_MS : AUDIT_QUIET_MS;
    const maxDirtyMs = optionalOnly ? OPTIONAL_AUDIT_MAX_DIRTY_MS : AUDIT_MAX_DIRTY_MS;
    const deadline = Math.min(
      (this.auditLastDirtyAt ?? now) + quietMs,
      (this.auditDirtySince ?? now) + maxDirtyMs,
    );
    this.auditTimer = setTimeout(() => this.runScheduledAudit(), Math.max(0, deadline - now));
    this.auditTimer.unref();
  }

  private runScheduledAudit(): void {
    this.auditTimer = null;
    if (!this.host.isActive()) return;
    const now = performance.now();
    const optionalOnly = this.isOptionalOnly();
    const quietMs = optionalOnly ? OPTIONAL_AUDIT_QUIET_MS : AUDIT_QUIET_MS;
    const maxDirtyMs = optionalOnly ? OPTIONAL_AUDIT_MAX_DIRTY_MS : AUDIT_MAX_DIRTY_MS;
    const deadline = Math.min(
      (this.auditLastDirtyAt ?? now) + quietMs,
      (this.auditDirtySince ?? now) + maxDirtyMs,
    );
    if (now < deadline) {
      this.scheduleAudit();
      return;
    }
    this.auditQueued = true;
    void this.enqueueAudit(true, this.generation).catch((error: unknown) =>
      this.host.fail(toError(error)),
    );
  }

  private isOptionalOnly(): boolean {
    return (
      !this.fullAuditRequested &&
      this.localScopes.size === 0 &&
      this.recursiveScopes.size === 0 &&
      this.changeScopes.size > 0
    );
  }

  private requestSafetyAudit(): void {
    const now = performance.now();
    this.safetyAuditPending = true;
    this.safetyAuditDirtySince ??= now;
    this.safetyAuditLastDirtyAt = now;
    this.scheduleFullAudit();
  }

  private scheduleFullAudit(): void {
    if (
      !this.host.isActive() ||
      !this.safetyAuditPending ||
      this.auditRunning ||
      this.fullAuditTimer
    ) {
      return;
    }
    const now = performance.now();
    const deadline = this.fullAuditDeadline(now);
    this.fullAuditTimer = setTimeout(
      () => this.runScheduledFullAudit(),
      Math.max(0, deadline - now),
    );
    this.fullAuditTimer.unref();
  }

  private runScheduledFullAudit(): void {
    this.fullAuditTimer = null;
    if (!this.host.isActive() || !this.safetyAuditPending || this.auditRunning) return;
    const now = performance.now();
    if (now < this.fullAuditDeadline(now)) {
      this.scheduleFullAudit();
      return;
    }
    this.safetyAuditPending = false;
    this.fullAuditRequested = true;
    this.auditDirty = true;
    this.auditDirtySince ??= now;
    this.scheduleAudit();
  }

  private fullAuditDeadline(now: number): number {
    const quietDeadline = (this.safetyAuditLastDirtyAt ?? now) + FULL_AUDIT_QUIET_MS;
    const intervalDeadline = this.lastFullAuditAt + FULL_AUDIT_MIN_INTERVAL_MS;
    const starvationDeadline = (this.safetyAuditDirtySince ?? now) + FULL_AUDIT_MAX_DIRTY_MS;
    return Math.min(starvationDeadline, Math.max(intervalDeadline, quietDeadline));
  }

  private clearSafetyAudit(): void {
    this.safetyAuditPending = false;
    this.safetyAuditDirtySince = null;
    this.safetyAuditLastDirtyAt = null;
    if (this.fullAuditTimer) clearTimeout(this.fullAuditTimer);
    this.fullAuditTimer = null;
  }

  private cancelAudits(): void {
    if (this.auditTimer) clearTimeout(this.auditTimer);
    if (this.fullAuditTimer) clearTimeout(this.fullAuditTimer);
    this.auditTimer = null;
    this.fullAuditTimer = null;
    this.localScopes.clear();
    this.changeScopes.clear();
    this.recursiveScopes.clear();
    this.fullAuditRequested = false;
    this.auditDirty = false;
    this.auditDirtySince = null;
    this.auditLastDirtyAt = null;
    this.safetyAuditPending = false;
    this.safetyAuditDirtySince = null;
    this.safetyAuditLastDirtyAt = null;
  }

  private acceptChange(path: string, scope: string, knownDirectory: boolean): void {
    this.requestChangeAudit(scope);
    this.host.queueEvent("update", path);
    if (knownDirectory) this.requestAudit(path, true);
  }

  private verifyChange(path: string, scope: string, knownDirectory: boolean): void {
    if (this.classificationQueue.length >= MAX_QUEUED_CLASSIFICATIONS) {
      this.acceptChange(path, scope, knownDirectory);
      return;
    }
    this.classificationQueue.push({
      path,
      run: () => this.runChangeVerification(path, scope, knownDirectory),
    });
    this.pumpClassifications();
  }

  private async runChangeVerification(
    path: string,
    scope: string,
    knownDirectory: boolean,
  ): Promise<void> {
    let signature: ChangeSignature | null = null;
    let missing = false;
    try {
      signature = this.signatureOf(await stat(path));
    } catch (error) {
      // Unreadable (a locked file on Windows) is announced and left to the scoped audit.
      missing = isMissingPathError(error);
    }
    if (!this.host.isActive() || this.host.isIgnored(path)) return;
    if (missing) {
      // Gone before the stat. The stat of its removal event may have settled first and announced
      // the delete; an update queued now would merge with it into an update of a missing file.
      // A scan of the parent announces the delete if no removal event did.
      this.rememberSignature(path, null);
      this.requestAudit(scope);
      return;
    }
    const previous = this.changeSignatures.get(path);
    if (signature && previous && !previous.racy && previous.value === signature.value) {
      this.host.metrics.nativeUnchangedChangeEventCount += 1;
      // Keep paths that keep being reported (Git metadata) at the recent end of the bound.
      this.rememberSignature(path, previous);
      return;
    }
    this.rememberSignature(path, signature);
    this.acceptChange(path, scope, knownDirectory);
  }

  private signatureOf(stats: Stats): ChangeSignature {
    // An access-time commit leaves all of these alone. A write moves the change
    // time even when it keeps the size and restores the modification time.
    const value = [
      stats.isDirectory() ? "d" : "f",
      stats.mtimeMs,
      stats.ctimeMs,
      stats.size,
      stats.ino,
      stats.birthtimeMs,
    ].join(":");
    const changedAt = Math.max(stats.mtimeMs, stats.ctimeMs);
    return { value, racy: this.now() - changedAt < CHANGE_SIGNATURE_RACY_WINDOW_MS };
  }

  private rememberSignature(path: string, signature: ChangeSignature | null): void {
    if (!this.filterUnchangedChanges) return;
    this.changeSignatures.delete(path);
    if (!signature) return;
    this.changeSignatures.set(path, signature);
    if (this.changeSignatures.size > this.maxChangeSignatures) {
      const oldest = this.changeSignatures.keys().next().value;
      if (oldest !== undefined) this.changeSignatures.delete(oldest);
    }
  }

  private classify(path: string, onPresent: (isDirectory: boolean) => void): void {
    if (this.classificationQueue.length >= MAX_QUEUED_CLASSIFICATIONS) {
      // Shed load onto the scoped audit, which reads the directory once instead
      // of stat-ing every entry in it.
      this.requestAudit(dirname(path));
      return;
    }
    this.classificationQueue.push({ path, run: () => this.runClassification(path, onPresent) });
    this.pumpClassifications();
  }

  private discardIgnoredClassifications(): void {
    let kept = 0;
    for (const classification of this.classificationQueue) {
      if (!this.host.isIgnored(classification.path)) {
        this.classificationQueue[kept++] = classification;
      }
    }
    this.classificationQueue.length = kept;
  }

  private pumpClassifications(): void {
    while (
      this.classifications.size < MAX_CONCURRENT_CLASSIFICATIONS &&
      this.classificationQueue.length > 0
    ) {
      const next = this.classificationQueue.shift();
      if (!next) return;
      this.startStatJob(next);
    }
  }

  private startStatJob(job: StatJob): void {
    let running!: Promise<void>;
    running = job.run().finally(() => {
      this.classifications.delete(running);
      if (this.host.isActive()) this.pumpClassifications();
    });
    this.classifications.add(running);
  }

  private runClassification(
    path: string,
    onPresent: (isDirectory: boolean) => void,
  ): Promise<void> {
    this.host.metrics.nativeClassificationCount += 1;
    return stat(path)
      .then((stats) => {
        this.host.queueEvent("create", path);
        // Consumers now know this state; a later change has to move it to count.
        this.rememberSignature(path, this.signatureOf(stats));
        if (this.host.isActive() && !this.host.isIgnored(path)) onPresent(stats.isDirectory());
        return undefined;
      })
      .catch((error: unknown) => {
        if (isMissingPathError(error)) {
          this.changeSignatures.delete(path);
          this.host.queueEvent("delete", path);
          return;
        }
        this.host.fail(toError(error));
      });
  }

  private assertWithinLimit(entryCount: number): void {
    if (entryCount <= MAX_TRACKED_ENTRIES) return;
    throw new Error(
      `Recursive file observation exceeded ${MAX_TRACKED_ENTRIES} entries under ${this.host.root}`,
    );
  }

  private canCommit(generation: number): boolean {
    return this.host.isActive() && generation === this.generation;
  }
}
