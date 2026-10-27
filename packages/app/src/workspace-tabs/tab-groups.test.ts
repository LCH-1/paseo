import { describe, expect, it } from "vitest";
import {
  assignToTabGroup,
  projectTabGroups,
  reorderTabGroups,
  removeFromTabGroups,
  GROUP_HEADER_PREFIX,
  type TabGroupsState,
} from "./tab-groups";
const tab = (key: string) => ({
  key,
  tabId: key,
  kind: "new_tab" as const,
  target: { kind: "new_tab" as const },
});
const initial = (): TabGroupsState => ({
  order: [],
  groups: [
    {
      id: "one",
      name: "작업",
      color: "blue",
      collapsed: false,
      closed: false,
      tabs: [tab("a"), tab("b")],
    },
    { id: "two", name: "확인", color: "red", collapsed: false, closed: false, tabs: [tab("d")] },
  ],
});
const rows = ["a", "b", "c", "d", "e"].map((key) => ({ tab: tab(key) }));
const projected = (state: TabGroupsState) =>
  projectTabGroups(state, rows).map((item) =>
    "group" in item ? GROUP_HEADER_PREFIX + item.group.id : item.row.tab.key,
  );
describe("tab groups", () => {
  it("projects each contiguous group once without changing tab identity", () => {
    expect(projected(initial())).toEqual([
      GROUP_HEADER_PREFIX + "one",
      "a",
      "b",
      "c",
      GROUP_HEADER_PREFIX + "two",
      "d",
      "e",
    ]);
  });
  it("collapses the members while preserving them for expand", () => {
    const s = initial();
    s.groups[0].collapsed = true;
    expect(projected(s)).toEqual([
      GROUP_HEADER_PREFIX + "one",
      "c",
      GROUP_HEADER_PREFIX + "two",
      "d",
      "e",
    ]);
    expect(s.groups[0].tabs.map((t) => t.key)).toEqual(["a", "b"]);
  });
  it("closed groups remain saved but leave the strip", () => {
    const s = initial();
    s.groups[0].closed = true;
    expect(projected(s)).toEqual(["c", GROUP_HEADER_PREFIX + "two", "d", "e"]);
    expect(s.groups[0].tabs.length).toBe(2);
  });
  it("moves a tab between groups with a single membership", () => {
    const s = assignToTabGroup(initial(), "two", [tab("b")]);
    expect(s.groups[0].tabs.map((t) => t.key)).toEqual(["a"]);
    expect(s.groups[1].tabs.map((t) => t.key)).toEqual(["d", "b"]);
  });
  it("removes empty groups when the last member leaves", () => {
    const s = removeFromTabGroups(initial(), ["a", "b"]);
    expect(s.groups.map((g) => g.id)).toEqual(["two"]);
  });
  it("moving a group header moves all of its members together", () => {
    const s = reorderTabGroups(
      initial(),
      ["c", GROUP_HEADER_PREFIX + "two", "d", "e", GROUP_HEADER_PREFIX + "one", "a", "b"],
      GROUP_HEADER_PREFIX + "one",
    );
    expect(s.order).toEqual(["c", "d", "e", "a", "b"]);
  });
  it("moving a collapsed header preserves all hidden members", () => {
    const state = initial();
    state.groups[0].collapsed = true;
    const s = reorderTabGroups(
      state,
      ["c", GROUP_HEADER_PREFIX + "two", "d", "e", GROUP_HEADER_PREFIX + "one"],
      GROUP_HEADER_PREFIX + "one",
    );
    expect(s.order).toEqual(["c", "d", "e", "a", "b"]);
  });
  it("removing a grouped tab to the beginning ungroups it", () => {
    const s = reorderTabGroups(
      initial(),
      ["b", GROUP_HEADER_PREFIX + "one", "a", "c", GROUP_HEADER_PREFIX + "two", "d", "e"],
      "b",
    );
    expect(s.groups[0].tabs.map((t) => t.key)).toEqual(["a"]);
    expect(s.order[0]).toBe("b");
  });
  it("restores saved grouping without dropping temporarily disconnected rows", () => {
    const s = JSON.parse(JSON.stringify(initial()));
    expect(projected(s)).toEqual(projected(initial()));
    expect(
      projectTabGroups(s, rows.slice(2)).map((item) =>
        "group" in item ? item.group.id : item.row.tab.key,
      ),
    ).toEqual(["c", "two", "d", "e"]);
    expect(s.groups[0].tabs.length).toBe(2);
  });
});

it("reorders tabs inside an expanded group", () => {
  const s = reorderTabGroups(
    initial(),
    [GROUP_HEADER_PREFIX + "one", "b", "a", "c", GROUP_HEADER_PREFIX + "two", "d", "e"],
    "b",
  );
  expect(s.groups[0].tabs.map((t) => t.key)).toEqual(["b", "a"]);
});

it("moving a group to another window hides it only in the source and keeps its members", () => {
  const state = initial();
  state.groups[0].windowKey = "target";
  expect(
    projectTabGroups(state, rows, "main").map((item) =>
      "group" in item ? item.group.id : item.row.tab.key,
    ),
  ).toEqual(["c", "two", "d", "e"]);
  expect(
    projectTabGroups(state, rows, "target", "one").map((item) =>
      "group" in item ? item.group.id : item.row.tab.key,
    ),
  ).toEqual(["one", "a", "b"]);
});

for (const collapsed of [false, true]) {
  it(`adds an ungrouped tab dropped on a ${collapsed ? "collapsed" : "expanded"} header from the right`, () => {
    const state = initial();
    state.groups[0].collapsed = collapsed;
    const visible = [
      "e",
      GROUP_HEADER_PREFIX + "one",
      ...(collapsed ? [] : ["a", "b"]),
      "c",
      GROUP_HEADER_PREFIX + "two",
      "d",
    ];
    const next = reorderTabGroups(state, visible, "e", {
      overKey: GROUP_HEADER_PREFIX + "one",
      tab: tab("e"),
    });
    expect(next.groups[0].tabs.map((t) => t.key)).toEqual(["e", "a", "b"]);
    expect(next.groups[0].collapsed).toBe(collapsed);
    expect(projected(next)[0]).toBe(GROUP_HEADER_PREFIX + "one");
  });
}
it("adds an outside tab dropped on the first group member from the right", () => {
  const next = reorderTabGroups(
    initial(),
    [GROUP_HEADER_PREFIX + "one", "e", "a", "b", "c", GROUP_HEADER_PREFIX + "two", "d"],
    "e",
    { overKey: "a", tab: tab("e") },
  );
  expect(next.groups[0].tabs.map((t) => t.key)).toEqual(["e", "a", "b"]);
});
it("moves a member directly onto another group header without retaining old membership", () => {
  const next = reorderTabGroups(
    initial(),
    [GROUP_HEADER_PREFIX + "one", "a", "c", GROUP_HEADER_PREFIX + "two", "b", "d", "e"],
    "b",
    { overKey: GROUP_HEADER_PREFIX + "two", tab: tab("b") },
  );
  expect(next.groups.map((g) => g.tabs.map((t) => t.key))).toEqual([["a"], ["b", "d"]]);
});
it("dropping outside a group removes membership even when the previous tab is grouped", () => {
  const next = reorderTabGroups(
    initial(),
    [GROUP_HEADER_PREFIX + "one", "a", "b", "c", GROUP_HEADER_PREFIX + "two", "d", "e"],
    "b",
    { overKey: "c", tab: tab("b") },
  );
  expect(next.groups[0].tabs.map((t) => t.key)).toEqual(["a"]);
});
