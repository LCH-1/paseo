import { describe, expect, it, vi } from "vitest";
import { markActivitySessionsRead } from "./mark-all-read";

describe("mark activity sessions read", () => {
  it("does nothing for an empty list", async () => {
    const getClient = vi.fn();
    expect(await markActivitySessionsRead([], getClient)).toBe(0);
    expect(getClient).not.toHaveBeenCalled();
  });
  it("routes each unread session to its own host", async () => {
    const left = { clearAgentAttention: vi.fn().mockResolvedValue(undefined) };
    const right = { clearAgentAttention: vi.fn().mockResolvedValue(undefined) };
    expect(
      await markActivitySessionsRead(
        [
          { serverId: "left", id: "a" },
          { serverId: "right", id: "b" },
        ],
        (id) => (id === "left" ? left : right),
      ),
    ).toBe(0);
    expect(left.clearAgentAttention).toHaveBeenCalledExactlyOnceWith("a");
    expect(right.clearAgentAttention).toHaveBeenCalledExactlyOnceWith("b");
  });
  it("continues after disconnected hosts and failed requests", async () => {
    const clearAgentAttention = vi.fn(async (id: string) => {
      if (id === "bad") throw Error("disconnected");
    });
    const agents = [
      { serverId: "host", id: "bad" },
      { serverId: "gone", id: "offline" },
      { serverId: "host", id: "good" },
    ];
    expect(
      await markActivitySessionsRead(agents, (id) =>
        id === "gone" ? null : { clearAgentAttention },
      ),
    ).toBe(2);
    expect(clearAgentAttention).toHaveBeenCalledWith("good");
  });
  it("caps parallel requests at four while processing the entire list", async () => {
    let active = 0,
      max = 0;
    const clearAgentAttention = vi.fn(async () => {
      active++;
      max = Math.max(active, max);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    });
    const agents = Array.from({ length: 13 }, (_, id) => ({ serverId: "host", id: String(id) }));
    expect(await markActivitySessionsRead(agents, () => ({ clearAgentAttention }))).toBe(0);
    expect(max).toBe(4);
    expect(clearAgentAttention).toHaveBeenCalledTimes(13);
  });
});
