import { describe, expect, it } from "vitest";
import { createLimiter, startInOrder } from "./ordered-start.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("startInOrder", () => {
  it("loads side by side and publishes in item order", async () => {
    const events: string[] = [];
    const delays = [40, 20, 0];

    await startInOrder([0, 1, 2], 4, async (item, turn) => {
      events.push(`load:${item}`);
      await pause(delays[item]!);
      events.push(`loaded:${item}`);
      await turn();
      events.push(`publish:${item}`);
    });

    expect(events.slice(0, 3)).toEqual(["load:0", "load:1", "load:2"]);
    expect(events.filter((event) => event.startsWith("publish"))).toEqual([
      "publish:0",
      "publish:1",
      "publish:2",
    ]);
    expect(events.indexOf("loaded:2")).toBeLessThan(events.indexOf("loaded:0"));
  });

  it("keeps at most `limit` items loading", async () => {
    let loading = 0;
    let peak = 0;

    await startInOrder([...Array(9).keys()], 3, async (_item, turn) => {
      loading += 1;
      peak = Math.max(peak, loading);
      await pause(5);
      loading -= 1;
      await turn();
    });

    expect(peak).toBe(3);
  });

  it("finishes every item in order when some fail or never take their turn", async () => {
    const published: number[] = [];

    const run = startInOrder([0, 1, 2, 3], 2, async (item, turn) => {
      await pause(item === 0 ? 20 : 0);
      if (item === 1) throw new Error("item 1 failed");
      if (item === 2) return;
      await turn();
      published.push(item);
    });

    await expect(run).rejects.toThrow("item 1 failed");
    expect(published).toEqual([0, 3]);
  });
});

describe("createLimiter", () => {
  it("runs at most `limit` tasks at once and passes results through", async () => {
    const limit = createLimiter(2);
    let running = 0;
    let peak = 0;
    const task = async (value: number) => {
      running += 1;
      peak = Math.max(peak, running);
      await pause(5);
      running -= 1;
      if (value === 5) throw new Error("five");
      return value * 10;
    };
    const describeFailure = (error: Error) => error.message;

    const run = (value: number) => limit(task.bind(null, value)).catch(describeFailure);

    const results = await Promise.all([1, 2, 3, 4, 5].map(run));

    expect(results).toEqual([10, 20, 30, 40, "five"]);
    expect(peak).toBe(2);
  });
});
