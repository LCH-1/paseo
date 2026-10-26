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
