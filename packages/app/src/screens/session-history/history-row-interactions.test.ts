// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { attachHistoryRowInteractions } from "./history-row-interactions.web";

afterEach(() => document.body.replaceChildren());

function setup() {
  const table = document.createElement("div");
  const row = document.createElement("div");
  Object.assign(row.dataset, {
    historyServerId: "host-a",
    historyWorkspaceId: "workspace-a",
    historyAgentId: "agent-a",
  });
  const text = document.createElement("span");
  row.append(text);
  table.append(row);
  document.body.append(table);
  const open = vi.fn();
  const navigate = vi.fn();
  row.addEventListener("click", navigate);
  const release = attachHistoryRowInteractions(table, open);
  const dispatch = (type: string, init: MouseEventInit = {}) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    text.dispatchEvent(event);
    return event;
  };
  return { table, open, navigate, release, dispatch };
}

it.each([{ ctrlKey: true }, { metaKey: true }])(
  "opens a pinned background target without normal navigation for %o",
  (modifier) => {
    const { open, navigate, dispatch } = setup();
    expect(dispatch("click", modifier).defaultPrevented).toBe(true);
    expect(open.mock.calls).toEqual([
      [{ serverId: "host-a", workspaceId: "workspace-a", agentId: "agent-a" }],
    ]);
    expect(navigate).not.toHaveBeenCalled();
  },
);

it("prevents middle-button autoscroll and opens only once on release", () => {
  const { open, navigate, dispatch } = setup();
  expect(dispatch("mousedown", { button: 1 }).defaultPrevented).toBe(true);
  expect(open).not.toHaveBeenCalled();
  expect(dispatch("auxclick", { button: 1 }).defaultPrevented).toBe(true);
  expect(open).toHaveBeenCalledTimes(1);
  expect(navigate).not.toHaveBeenCalled();
});

it("preserves normal clicks, keyboard activation and right-click menus", () => {
  const { open, navigate, dispatch } = setup();
  expect(dispatch("click").defaultPrevented).toBe(false);
  expect(dispatch("click", { detail: 0 }).defaultPrevented).toBe(false);
  expect(dispatch("auxclick", { button: 2 }).defaultPrevented).toBe(false);
  expect(navigate).toHaveBeenCalledTimes(2);
  expect(open).not.toHaveBeenCalled();
});

it("ignores the toolbar and cleans up before a later mount", () => {
  const { table, open, release, dispatch } = setup();
  table.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
  release();
  expect(dispatch("click", { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(open).not.toHaveBeenCalled();
});
