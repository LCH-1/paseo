import { describe, expect, test } from "vitest";
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
});
