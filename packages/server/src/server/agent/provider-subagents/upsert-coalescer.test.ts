import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ProviderSubagentDescriptor } from "./store.js";
import {
  PROVIDER_SUBAGENT_UPSERT_WINDOW_MS,
  ProviderSubagentUpsertCoalescer,
} from "./upsert-coalescer.js";

function createHarness() {
  const sent: ProviderSubagentDescriptor[] = [];
  const coalescer = new ProviderSubagentUpsertCoalescer({
    timers: { setTimeout, clearTimeout },
    onSend: (subagent) => {
      sent.push(subagent);
    },
  });
  return { coalescer, sent };
}

function descriptor(
  id: string,
  overrides: Partial<ProviderSubagentDescriptor> = {},
): ProviderSubagentDescriptor {
  return {
    id,
    parentAgentId: "parent",
    parentSubagentId: null,
    provider: "claude",
    title: "Explore",
    description: null,
    status: "running",
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
    toolCallId: id,
    cwd: null,
    subtitle: null,
    ...overrides,
  };
}

describe("ProviderSubagentUpsertCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("sends a lone descriptor at once", () => {
    const { coalescer, sent } = createHarness();
    const completed = descriptor("child", { status: "completed" });

    coalescer.push(completed);

    expect(sent).toEqual([completed]);
  });

  test("a burst for one subagent sends the first report and then only the newest", () => {
    const { coalescer, sent } = createHarness();
    const burst = Array.from({ length: 1000 }, (_, index) =>
      descriptor("child", { subtitle: `${index} tokens` }),
    );
    const final = descriptor("child", { subtitle: "1000 tokens", status: "completed" });

    for (const report of burst) coalescer.push(report);
    coalescer.push(final);
    expect(sent).toEqual([burst[0]]);

    vi.advanceTimersByTime(PROVIDER_SUBAGENT_UPSERT_WINDOW_MS);

    expect(sent).toEqual([burst[0], final]);
  });

  test("a sustained burst stays at one descriptor per window and ends on the final state", () => {
    const { coalescer, sent } = createHarness();
    const windows = 5;
    const reportsPerWindow = 200;
    let last = descriptor("child");

    for (let window = 0; window < windows; window += 1) {
      for (let report = 0; report < reportsPerWindow; report += 1) {
        last = descriptor("child", { subtitle: `${window}:${report}` });
        coalescer.push(last);
      }
      vi.advanceTimersByTime(PROVIDER_SUBAGENT_UPSERT_WINDOW_MS);
    }
    vi.advanceTimersByTime(PROVIDER_SUBAGENT_UPSERT_WINDOW_MS);

    expect(sent).toHaveLength(windows + 1);
    expect(sent.at(-1)).toEqual(last);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("subagents do not delay each other", () => {
    const { coalescer, sent } = createHarness();
    const first = descriptor("child-1");
    const second = descriptor("child-2");
    const sibling = descriptor("child-1", { parentAgentId: "other-parent" });

    coalescer.push(first);
    coalescer.push(second);
    coalescer.push(sibling);

    expect(sent).toEqual([first, second, sibling]);
  });

  test("a removed subagent's waiting descriptor is never sent", () => {
    const { coalescer, sent } = createHarness();
    const declared = descriptor("child");

    coalescer.push(declared);
    coalescer.push(descriptor("child", { status: "completed" }));
    coalescer.discard("parent", "child");
    vi.advanceTimersByTime(PROVIDER_SUBAGENT_UPSERT_WINDOW_MS);

    expect(sent).toEqual([declared]);
  });

  test("a subagent declared again after removal is sent once the window closes", () => {
    const { coalescer, sent } = createHarness();
    const declared = descriptor("child");
    const replayed = descriptor("child", { status: "completed" });

    coalescer.push(declared);
    coalescer.discard("parent", "child");
    coalescer.push(replayed);
    vi.advanceTimersByTime(PROVIDER_SUBAGENT_UPSERT_WINDOW_MS);

    expect(sent).toEqual([declared, replayed]);
  });

  test("dispose drops what was waiting and stops the timer", () => {
    const { coalescer, sent } = createHarness();
    const declared = descriptor("child");

    coalescer.push(declared);
    coalescer.push(descriptor("child", { status: "completed" }));
    coalescer.dispose();
    vi.advanceTimersByTime(PROVIDER_SUBAGENT_UPSERT_WINDOW_MS);

    expect(sent).toEqual([declared]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
