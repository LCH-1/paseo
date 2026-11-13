import { describe, expect, test } from "vitest";
import type { GitProcessPriority } from "../utils/git-process-scheduler.js";
import { getGitCommandPriority, runWithGitCommandPriority } from "../utils/run-git-command.js";
import { WorkspaceRefreshAdmission } from "./workspace-refresh-admission.js";

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe("WorkspaceRefreshAdmission", () => {
  test("admits up to the limit in arrival order, letting an urgent refresh go first", async () => {
    const admission = new WorkspaceRefreshAdmission(1);
    const started: string[] = [];
    const first = createDeferred();
    const urgent = new Set<string>();
    const queue = (name: string, wait?: Promise<void>) =>
      admission.run(
        async () => {
          started.push(name);
          await wait;
        },
        () => urgent.has(name),
      );

    const running = queue("first", first.promise);
    const later = [queue("second"), queue("third"), queue("fourth")];
    await Promise.resolve();
    expect(started).toEqual(["first"]);
    expect(admission.pendingCount).toBe(3);

    // Urgency is read when the slot frees, not when the refresh was queued.
    urgent.add("third");
    first.resolve();
    await Promise.all([running, ...later]);
    expect(started).toEqual(["first", "third", "second", "fourth"]);
    expect(admission.activeCount).toBe(0);
  });

  test("clearing the queue rejects refreshes that were not admitted", async () => {
    const admission = new WorkspaceRefreshAdmission(1);
    const gate = createDeferred();
    const running = admission.run(
      () => gate.promise,
      () => false,
    );
    const queued = admission.run(
      async () => "never",
      () => false,
    );

    admission.clearQueue();
    await expect(queued).rejects.toThrow("Workspace refresh admission was cleared");
    gate.resolve();
    await running;
    expect(admission.pendingCount).toBe(0);
  });

  // Git priority travels in the async context. A queued refresh is started from the one that
  // freed its slot, so it must not pick up that refresh's priority or lose its caller's.
  test.each<{ holder: GitProcessPriority; queued: GitProcessPriority }>([
    { holder: "normal", queued: "high" },
    { holder: "high", queued: "normal" },
  ])(
    "a refresh queued behind a $holder one runs its Git at its caller's $queued priority",
    async ({ holder, queued }) => {
      const admission = new WorkspaceRefreshAdmission(1);
      const gate = createDeferred();
      const seen: GitProcessPriority[] = [];
      const recordPriority = (wait?: Promise<void>) => async () => {
        seen.push(getGitCommandPriority());
        await wait;
      };
      const notUrgent = () => false;
      const enqueue = (priority: GitProcessPriority, wait?: Promise<void>) =>
        runWithGitCommandPriority(priority, () => admission.run(recordPriority(wait), notUrgent));

      const running = enqueue(holder, gate.promise);
      const waiting = enqueue(queued);
      await Promise.resolve();
      expect(admission.pendingCount).toBe(1);

      gate.resolve();
      await Promise.all([running, waiting]);
      expect(seen).toEqual([holder, queued]);
    },
  );
});
