import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import type { CheckoutSnapshotFacts, CheckoutStatusGit } from "../utils/checkout-git.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import {
  startGitCommandMetrics,
  stopGitCommandMetrics,
  waitForGitCommandMetricsIdle,
} from "../utils/run-git-command.js";
import { createFileObserver } from "./file-observer/index.js";
import { fetchWorkspaceGitRemote } from "./workspace-git-fetch.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import type { FileChange, FileObserver, SubscribeToFileChanges } from "./file-observer/index.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    warn: vi.fn(),
  };
  return logger as unknown as pino.Logger;
}

function createFacts(cwd: string): CheckoutSnapshotFacts {
  return {
    isGit: true,
    worktreeRoot: cwd,
    currentBranch: "main",
    remoteUrl: null,
    absoluteGitDir: path.join(cwd, ".git"),
    gitCommonDir: path.join(cwd, ".git"),
    paseoWorktree: { isPaseoOwnedWorktree: false },
    storedBaseRef: null,
    resolvedBaseRef: "main",
    mainRepoRoot: null,
    comparisonBaseRef: null,
    branchRemoteName: null,
    branchMergeRef: null,
    pullRequestLookupTarget: { headRef: "main" },
  };
}

function createStatus(cwd: string): CheckoutStatusGit {
  return {
    isGit: true,
    repoRoot: cwd,
    mainRepoRoot: null,
    currentBranch: "main",
    isDirty: false,
    baseRef: "main",
    aheadBehind: { ahead: 0, behind: 0 },
    aheadOfOrigin: null,
    behindOfOrigin: null,
    hasRemote: false,
    remoteUrl: null,
    isPaseoOwnedWorktree: false,
  };
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

test("a fresh checkout read makes a newly initialized repository available to cached readers", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-checkout-init-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    paseoHome: path.join(root, "home"),
  });
  cleanup.push(async () => {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  expect((await service.getSnapshot(repo, { includeForge: false })).git.isGit).toBe(false);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });

  expect((await service.getCheckout(repo)).isGit).toBe(true);
  const repoRoot = await service.resolveRepoRoot(repo);
  expect(realpathSync.native(repoRoot)).toBe(realpathSync.native(repo));
}, 30_000);

test("recursive observation updates tracked state and prunes ignored storms", async () => {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-git-observation-")));
  const repoDir = path.join(tempDir, "repo");
  const trackedPath = path.join(repoDir, "src", "tracked.txt");
  const ignoredDir = path.join(repoDir, "build");
  const remainingIgnoredDir = path.join(repoDir, "cache");
  const newlyTrackedPath = path.join(ignoredDir, "tracked.txt");
  mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  mkdirSync(path.dirname(trackedPath), { recursive: true });
  mkdirSync(ignoredDir, { recursive: true });
  mkdirSync(remainingIgnoredDir, { recursive: true });
  writeFileSync(trackedPath, "base\n");
  writeFileSync(newlyTrackedPath, "base\n");

  let activeWatcherCount = 0;
  const observer = createFileObserver();
  let watcherStartCount = 0;
  let onWorkingTreeIgnoreUpdated: (() => void) | null = null;
  const deliveredEvents: Array<{
    directory: string;
    events: FileChange[];
  }> = [];
  const subscribe: SubscribeToFileChanges = async (directory, callback, options) => {
    const subscription = await observer.subscribe(
      directory,
      (error, events) => {
        deliveredEvents.push({ directory, events });
        callback(error, events);
      },
      options,
    );
    activeWatcherCount += 1;
    watcherStartCount += 1;
    return {
      updateIgnore: async (paths) => {
        await subscription.updateIgnore(paths);
        if (directory === repoDir) {
          const onUpdated = onWorkingTreeIgnoreUpdated;
          onWorkingTreeIgnoreUpdated = null;
          onUpdated?.();
        }
      },
      unsubscribe: async () => {
        await subscription.unsubscribe();
        activeWatcherCount -= 1;
      },
    };
  };
  const fileObserver = {
    subscribe,
    getDiagnostics: () => observer.getDiagnostics(),
    close: () => observer.close(),
  };
  let observedPath = trackedPath;
  let observedRelativePath = "src/tracked.txt";
  const readObservedState = () => {
    const contents = readFileSync(observedPath, "utf8");
    const isDirty = contents !== "base\n";
    return {
      isDirty,
      additions: isDirty ? contents.trim().split("\n").length : 0,
    };
  };
  const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createFacts(cwd));
  const getCheckoutStatus = vi.fn(async (cwd: string) => ({
    ...createStatus(cwd),
    isDirty: readObservedState().isDirty,
  }));
  const getCheckoutShortstat = vi.fn(async () => ({
    additions: readObservedState().additions,
    deletions: 0,
  }));
  const getCheckoutWorktreeState = vi.fn(async () => {
    const additions = readObservedState().additions;
    return { isDirty: true, diffStat: { additions, deletions: 0 } };
  });
  const getCheckoutDiff = vi.fn(async () => {
    const additions = readObservedState().additions;
    return {
      diff: "",
      structured: [
        { path: observedRelativePath, additions, deletions: 0, status: "modified" as const },
      ],
    };
  });
  let buildIgnored = true;
  const runGitCommand = vi.fn(async (args: string[]) => {
    if (args[0] === "rev-parse") {
      return {
        stdout: `${repoDir}\n`,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      };
    }
    if (args[0] === "ls-files") {
      return {
        stdout: `${buildIgnored ? "build/\n" : ""}cache/\n`,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      };
    }
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  });
  const service = new WorkspaceGitServiceImpl({
    logger: createLogger(),
    paseoHome: path.join(tempDir, "paseo-home"),
    fileObserver,
    deps: {
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
      getCheckoutShortstat,
      getCheckoutWorktreeState,
      getCheckoutDiff,
      runGitCommand,
    } as never,
  });
  const diffManager = new CheckoutDiffManager({
    logger: createLogger(),
    paseoHome: path.join(tempDir, "paseo-home"),
    workspaceGitService: service,
  });
  const summaryListener = vi.fn();
  const diffListener = vi.fn();
  const summarySubscription = service.registerWorkspace({ cwd: repoDir }, summaryListener);
  const diffSubscription = await diffManager.subscribe(
    { cwd: repoDir, compare: { mode: "uncommitted" } },
    diffListener,
  );

  cleanup.push(async () => {
    diffSubscription.unsubscribe();
    summarySubscription.unsubscribe();
    diffManager.dispose();
    await service.dispose();
    expect(activeWatcherCount).toBe(0);
    rmSync(tempDir, { recursive: true, force: true });
  });

  await vi.waitFor(
    () => {
      expect(activeWatcherCount).toBe(2);
      expect(service.peekSnapshot(repoDir)).not.toBeNull();
      expect(service.getMetrics()).toMatchObject({
        workspaceObservationSetupInFlightCount: 0,
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  writeFileSync(trackedPath, "base\n");
  await vi.waitFor(
    () => {
      const events = deliveredEvents.flatMap((batch) => batch.events);
      expect(events.map((event) => event.path)).toContain(trackedPath);
      expect(getCheckoutWorktreeState).toHaveBeenCalled();
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  getCheckoutSnapshotFacts.mockClear();
  getCheckoutStatus.mockClear();
  getCheckoutShortstat.mockClear();
  getCheckoutWorktreeState.mockClear();
  getCheckoutDiff.mockClear();
  runGitCommand.mockClear();
  deliveredEvents.length = 0;

  expect(runGitCommand).not.toHaveBeenCalled();
  expect(getCheckoutWorktreeState).not.toHaveBeenCalled();
  expect(getCheckoutDiff, JSON.stringify(deliveredEvents)).not.toHaveBeenCalled();
  expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);

  for (let index = 0; index < 100; index += 1) {
    writeFileSync(path.join(ignoredDir, `artifact-${index}.txt`), `${index}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 750));

  expect(runGitCommand).not.toHaveBeenCalled();
  expect(getCheckoutSnapshotFacts).not.toHaveBeenCalled();
  expect(getCheckoutStatus).not.toHaveBeenCalled();
  expect(getCheckoutShortstat).not.toHaveBeenCalled();
  expect(getCheckoutWorktreeState).not.toHaveBeenCalled();
  expect(getCheckoutDiff).not.toHaveBeenCalled();
  expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);

  writeFileSync(trackedPath, "first\nsecond\n");
  await vi.waitFor(
    () => {
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: true,
            diffStat: { additions: 2, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: repoDir,
        files: [
          {
            path: "src/tracked.txt",
            additions: 2,
            deletions: 0,
            status: "modified",
          },
        ],
        error: null,
      });
      expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);
    },
    { timeout: 5_000 },
  );

  writeFileSync(trackedPath, "first\nsecond\nthird\n");
  await vi.waitFor(
    () => {
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            diffStat: { additions: 3, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          files: [expect.objectContaining({ additions: 3 })],
        }),
      );
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  expect(getCheckoutSnapshotFacts).not.toHaveBeenCalled();
  expect(getCheckoutStatus).not.toHaveBeenCalled();

  buildIgnored = false;
  observedPath = newlyTrackedPath;
  observedRelativePath = "build/tracked.txt";
  let editedDuringIgnoreUpdate = false;
  onWorkingTreeIgnoreUpdated = () => {
    editedDuringIgnoreUpdate = true;
    writeFileSync(newlyTrackedPath, "first\nsecond\n");
  };
  writeFileSync(path.join(repoDir, ".gitignore"), "cache/\n");
  await vi.waitFor(
    () => {
      expect(editedDuringIgnoreUpdate).toBe(true);
      expect(watcherStartCount).toBe(2);
      expect(activeWatcherCount).toBe(2);
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: true,
            diffStat: { additions: 2, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: repoDir,
        files: [
          {
            path: "build/tracked.txt",
            additions: 2,
            deletions: 0,
            status: "modified",
          },
        ],
        error: null,
      });
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 8_000 },
  );

  getCheckoutSnapshotFacts.mockClear();
  getCheckoutStatus.mockClear();
  getCheckoutShortstat.mockClear();
  getCheckoutWorktreeState.mockClear();
  getCheckoutDiff.mockClear();
  runGitCommand.mockClear();
  summaryListener.mockClear();
  diffListener.mockClear();

  writeFileSync(newlyTrackedPath, "first\nsecond\nthird\nfourth\n");
  await vi.waitFor(
    () => {
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: true,
            diffStat: { additions: 4, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: repoDir,
        files: [
          {
            path: "build/tracked.txt",
            additions: 4,
            deletions: 0,
            status: "modified",
          },
        ],
        error: null,
      });
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  getCheckoutSnapshotFacts.mockClear();
  getCheckoutStatus.mockClear();
  getCheckoutShortstat.mockClear();
  getCheckoutWorktreeState.mockClear();
  getCheckoutDiff.mockClear();
  runGitCommand.mockClear();

  for (let index = 0; index < 100; index += 1) {
    writeFileSync(path.join(remainingIgnoredDir, `artifact-${index}.txt`), `${index}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 750));

  expect(runGitCommand).not.toHaveBeenCalled();
  expect(getCheckoutSnapshotFacts).not.toHaveBeenCalled();
  expect(getCheckoutStatus).not.toHaveBeenCalled();
  expect(getCheckoutShortstat).not.toHaveBeenCalled();
  expect(getCheckoutWorktreeState).not.toHaveBeenCalled();
  expect(getCheckoutDiff).not.toHaveBeenCalled();
  expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);
}, 30_000);

test("a late Git-ignored tree is pruned while tracked changes still notify consumers", async () => {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-real-ignore-")));
  const repoDir = path.join(tempDir, "repo");
  mkdirSync(repoDir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n");
  const trackedPath = path.join(repoDir, "tracked.txt");
  writeFileSync(trackedPath, "before\n");
  git("add", ".gitignore", "tracked.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "fixture");

  const observer = createFileObserver();
  const ignoredDir = path.join(repoDir, "node_modules");
  const completedIgnoreUpdates: string[][] = [];
  let notifications = 0;
  let expectTrackedEdit = false;
  let trackedBatchReachedConsumer = false;
  // Observe the real subscription without replacing Git, filesystem, or watcher behavior.
  const fileObserver: FileObserver = {
    subscribe: async (directory, callback, options) => {
      const realSubscription = await observer.subscribe(
        directory,
        (error, events) => {
          const includesTrackedEdit =
            expectTrackedEdit && events.some((e) => e.path === trackedPath);
          const before = notifications;
          callback(error, events);
          if (includesTrackedEdit && notifications > before) trackedBatchReachedConsumer = true;
        },
        options,
      );
      return {
        updateIgnore: async (paths) => {
          await realSubscription.updateIgnore(paths);
          completedIgnoreUpdates.push([...paths]);
        },
        unsubscribe: () => realSubscription.unsubscribe(),
      };
    },
    getDiagnostics: () => observer.getDiagnostics(),
    close: () => observer.close(),
  };
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    paseoHome: path.join(tempDir, "home"),
    fileObserver,
  });
  let subscription: Awaited<ReturnType<typeof service.requestWorkingTreeWatch>> | undefined;
  try {
    subscription = await service.requestWorkingTreeWatch(repoDir, () => {
      notifications += 1;
    });
    for (let index = 0; index < 20; index += 1) {
      const directory = path.join(ignoredDir, `dependency-${index}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "index.js"), "first");
    }
    expect(git("ls-files", "-o", "-i", "--directory", "--exclude-standard")).toBe("node_modules/");
    await expect
      .poll(() => completedIgnoreUpdates.some((paths) => paths.includes(ignoredDir)), {
        timeout: 5_000,
      })
      .toBe(true);

    const atIgnoreBoundary = observer.getDiagnostics();
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(path.join(ignoredDir, `dependency-${index}`, "second.js"), "second");
    }
    expectTrackedEdit = true;
    writeFileSync(trackedPath, "after\n");
    await expect.poll(() => trackedBatchReachedConsumer, { timeout: 5_000 }).toBe(true);
    const afterTrackedEdit = observer.getDiagnostics();
    expect(afterTrackedEdit.nativeHandleCount).toBe(atIgnoreBoundary.nativeHandleCount);
    expect(afterTrackedEdit.nativeTrackedFileCount).toBe(atIgnoreBoundary.nativeTrackedFileCount);
    expect(
      afterTrackedEdit.nativeClassificationCount - atIgnoreBoundary.nativeClassificationCount,
    ).toBeLessThanOrEqual(1);
  } finally {
    subscription?.unsubscribe();
    await service.dispose();
    await observer.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}, 15_000);

// A Git that follows the remote HEAD (2.49 does) takes and releases
// `refs/remotes/origin/HEAD.lock` on every fetch, even when nothing moved. Windows then reports
// the parent directory as changed, after the fetch has already returned.
test("a background fetch that moves no ref leaves every workspace of the repository idle", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-noop-fetch-")));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const nested = path.join(repo, "packages", "app");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  mkdirSync(nested, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(nested, "index.ts"), "export {};\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "fixture");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "fetch", "-q", "origin", "--prune");

  let releaseFetch!: () => void;
  const fetchReleased = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    paseoHome: path.join(root, "home"),
    deps: {
      runGitFetch: async (cwd, observer, run) => {
        await fetchReleased;
        return fetchWorkspaceGitRemote(cwd, observer, run);
      },
    },
  });
  const snapshotCounts = new Map([
    [repo, 0],
    [nested, 0],
  ]);
  const subscriptions = [...snapshotCounts.keys()].map((cwd) =>
    service.registerWorkspace({ cwd }, () => {
      snapshotCounts.set(cwd, (snapshotCounts.get(cwd) ?? 0) + 1);
    }),
  );
  let metricsRunning = false;
  cleanup.push(async () => {
    releaseFetch();
    for (const subscription of subscriptions) subscription.unsubscribe();
    await service.dispose();
    if (metricsRunning) {
      await waitForGitCommandMetricsIdle({ quietMs: 0, timeoutMs: 30_000 });
      stopGitCommandMetrics();
    }
    rmSync(root, { recursive: true, force: true });
  });

  await vi.waitFor(
    () => {
      expect([...snapshotCounts.values()].every((count) => count >= 1)).toBe(true);
      expect(service.getMetrics()).toMatchObject({
        repositoryWorkspaceLinkCount: 2,
        fetchInFlightCount: 1,
        workspaceObservationSetupInFlightCount: 0,
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 20_000 },
  );

  const snapshotBaseline = new Map(snapshotCounts);
  startGitCommandMetrics();
  metricsRunning = true;
  releaseFetch();
  // The directory event trails the fetch by up to a second and the refresh it used to cause is
  // debounced for another one.
  await waitForGitCommandMetricsIdle({ quietMs: 4_000, timeoutMs: 30_000 });
  const fetchCycle = stopGitCommandMetrics();
  metricsRunning = false;

  expect(fetchCycle.submissions.map((command) => command.args[0])).toEqual([
    "for-each-ref",
    "fetch",
    "for-each-ref",
  ]);
  expect(new Map(snapshotCounts)).toEqual(snapshotBaseline);

  // Ignoring the directory must not cost a real change: a ref the user's own fetch moves and a
  // branch switch both still reach every workspace.
  const previous = git(origin, "rev-parse", "refs/heads/main");
  const tree = git(origin, "show", "-s", "--format=%T", previous);
  const next = git(
    origin,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit-tree",
    tree,
    "-p",
    previous,
    "-m",
    "advance",
  );
  git(origin, "update-ref", "refs/heads/main", next, previous);
  git(repo, "fetch", "-q", "origin", "--prune");
  await vi.waitFor(
    () => {
      expect(service.peekSnapshot(repo)?.git.behindOfOrigin).toBe(1);
      expect(service.peekSnapshot(nested)?.git.behindOfOrigin).toBe(1);
    },
    { timeout: 10_000 },
  );

  git(repo, "checkout", "-q", "-b", "feature");
  await vi.waitFor(
    () => {
      expect(service.peekSnapshot(repo)?.git.currentBranch).toBe("feature");
      expect(service.peekSnapshot(nested)?.git.currentBranch).toBe("feature");
    },
    { timeout: 10_000 },
  );
}, 60_000);
