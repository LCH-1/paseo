import { expect, it, vi } from "vitest";
import { agentTabPresenceBridge } from "./agent-tab-presence";

it("releases old sources without letting their later cleanup remove the replacement", () => {
  const notify = vi.fn();
  const unsubscribe = agentTabPresenceBridge.subscribe(notify);
  const releaseOld = vi.fn();
  const old = agentTabPresenceBridge.register({
    read: () => ({ isOpen: true, lastClosedAt: null }),
    subscribe: () => releaseOld,
  });
  const next = agentTabPresenceBridge.register({
    read: () => ({ isOpen: false, lastClosedAt: 123 }),
    subscribe: () => () => {},
  });
  expect(releaseOld).toHaveBeenCalledOnce();
  old();
  expect(agentTabPresenceBridge.read("h", "a")).toEqual({ isOpen: false, lastClosedAt: 123 });
  next();
  next();
  expect(agentTabPresenceBridge.read("h", "a")).toBeNull();
  expect(notify).toHaveBeenCalledTimes(3);
  unsubscribe();
});

it("retains background tabs only through the current source and releases cleanly", () => {
  const retain = vi.fn();
  const tab = {
    serverId: "host-a",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    tabId: "tab-a",
  };
  const release = agentTabPresenceBridge.register({
    read: () => ({ isOpen: false, lastClosedAt: null }),
    subscribe: () => () => {},
    retain,
  });
  agentTabPresenceBridge.retain(tab);
  expect(retain.mock.calls).toEqual([[tab]]);
  release();
  agentTabPresenceBridge.retain(tab);
  expect(retain).toHaveBeenCalledTimes(1);
});
