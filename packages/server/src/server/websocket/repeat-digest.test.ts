import { describe, expect, it } from "vitest";
import { RepeatDigest } from "./repeat-digest.js";

interface Kind {
  requestType: string;
}

const pluginRpc: Kind = { requestType: "plugin.rpc.invoke.request" };

describe("RepeatDigest", () => {
  it("leaves a one-off occurrence to the caller and adds no summary", () => {
    const digest = new RepeatDigest<Kind>();

    expect(digest.record("plugin-rpc", pluginRpc, 900)).toBe(true);
    expect(digest.flush()).toEqual([]);
  });

  it("summarizes every occurrence of a window once the kind repeats", () => {
    const digest = new RepeatDigest<Kind>();

    expect(digest.record("plugin-rpc", pluginRpc, 1_400)).toBe(true);
    expect(digest.record("plugin-rpc", pluginRpc, 2_700.4)).toBe(false);
    expect(digest.record("plugin-rpc", pluginRpc, 6_750)).toBe(false);

    expect(digest.flush()).toEqual([{ fields: pluginRpc, count: 3, p50Ms: 2_700, maxMs: 6_750 }]);
  });

  it("keeps a recurring kind collapsed in the following windows", () => {
    const digest = new RepeatDigest<Kind>();
    digest.record("plugin-rpc", pluginRpc, 1_400);
    digest.flush();

    expect(digest.record("plugin-rpc", pluginRpc, 1_500)).toBe(false);
    expect(digest.flush()).toEqual([{ fields: pluginRpc, count: 1, p50Ms: 1_500, maxMs: 1_500 }]);
  });

  it("keeps a kind collapsed across the quiet windows of a slower poll", () => {
    const digest = new RepeatDigest<Kind>();
    digest.record("plugin-rpc", pluginRpc, 1_400);
    for (let window = 0; window < 5; window += 1) digest.flush();

    expect(digest.record("plugin-rpc", pluginRpc, 1_500)).toBe(false);
  });

  it("hands a kind back to the caller after it stayed quiet", () => {
    const digest = new RepeatDigest<Kind>();
    digest.record("plugin-rpc", pluginRpc, 1_400);
    for (let window = 0; window < 6; window += 1) digest.flush();

    expect(digest.record("plugin-rpc", pluginRpc, 1_500)).toBe(true);
  });

  it("tracks kinds independently", () => {
    const digest = new RepeatDigest<Kind>();
    const usage: Kind = { requestType: "usage.list_reports.request" };
    digest.record("plugin-rpc", pluginRpc, 1_400);
    digest.record("plugin-rpc", pluginRpc, 1_600);

    expect(digest.record("usage", usage, 5_200)).toBe(true);
    expect(digest.flush()).toEqual([{ fields: pluginRpc, count: 2, p50Ms: 1_600, maxMs: 1_600 }]);
  });

  it("stops collapsing new kinds once the table is full", () => {
    const digest = new RepeatDigest<Kind>();
    for (let index = 0; index < 256; index += 1) {
      digest.record(`kind-${index}`, { requestType: `kind-${index}` }, 600);
    }

    expect(digest.record("overflow", { requestType: "overflow" }, 600)).toBe(true);
    expect(digest.record("overflow", { requestType: "overflow" }, 600)).toBe(true);
    expect(digest.flush()).toEqual([]);
  });
});
