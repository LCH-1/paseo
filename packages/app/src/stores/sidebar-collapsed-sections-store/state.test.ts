import { describe, expect, it } from "vitest";
import {
  type CollapsedProjectsState,
  mergePersistedCollapsedProjects,
  serializeCollapsedProjects,
  setProjectCollapsed,
  setProjectsCollapsed,
  setWorkspaceGroupsCollapsed,
  togglePinnedCollapsed,
  toggleProjectCollapsed,
  toggleWorkspaceGroupCollapsed,
} from "@/stores/sidebar-collapsed-sections-store/state";

function emptyState(): CollapsedProjectsState {
  return {
    collapsedProjectKeys: new Set(),
    collapsedWorkspaceGroupKeys: new Set(),
    collapsedPinned: false,
  };
}

describe("sidebar collapsed projects transitions", () => {
  it("tracks collapsed project keys as a Set", () => {
    let state = emptyState();

    state = setProjectCollapsed(state, "project-a", true);
    state = toggleProjectCollapsed(state, "project-b");
    state = toggleProjectCollapsed(state, "project-a");
    state = toggleWorkspaceGroupCollapsed(state, "running");

    expect(Array.from(state.collapsedProjectKeys)).toEqual(["project-b"]);
    expect(Array.from(state.collapsedWorkspaceGroupKeys)).toEqual(["running"]);
  });

  it("sets only the supplied host-scoped projects while preserving other collapse preferences", () => {
    const firstHostProject = 'host-project:["host-a","shared"]';
    const secondHostProject = 'host-project:["host-a","other"]';
    const otherHostProject = 'host-project:["host-b","shared"]';
    const hiddenProject = 'host-project:["host-a","hidden"]';
    const current: CollapsedProjectsState = {
      collapsedProjectKeys: new Set([otherHostProject, hiddenProject]),
      collapsedWorkspaceGroupKeys: new Set(["host:host-b", "running"]),
      collapsedPinned: true,
    };
    const collapsed = setProjectsCollapsed(current, [firstHostProject, secondHostProject], true);

    expect(collapsed.collapsedProjectKeys).toEqual(
      new Set([otherHostProject, hiddenProject, firstHostProject, secondHostProject]),
    );
    expect(current.collapsedProjectKeys).toEqual(new Set([otherHostProject, hiddenProject]));
    expect(collapsed.collapsedWorkspaceGroupKeys).toBe(current.collapsedWorkspaceGroupKeys);
    expect(collapsed.collapsedPinned).toBe(true);

    const expanded = setProjectsCollapsed(collapsed, [firstHostProject, secondHostProject], false);

    expect(expanded.collapsedProjectKeys).toEqual(new Set([otherHostProject, hiddenProject]));
    expect(expanded.collapsedWorkspaceGroupKeys).toBe(current.collapsedWorkspaceGroupKeys);
    expect(expanded.collapsedPinned).toBe(true);
  });

  it("sets only the supplied host groups while preserving status and hidden host groups", () => {
    const current: CollapsedProjectsState = {
      collapsedProjectKeys: new Set(['host-project:["host-a","shared"]']),
      collapsedWorkspaceGroupKeys: new Set(["running", "needs_input", "host:host-hidden"]),
      collapsedPinned: true,
    };
    const collapsed = setWorkspaceGroupsCollapsed(current, ["host:host-a", "host:host-b"], true);

    expect(collapsed.collapsedWorkspaceGroupKeys).toEqual(
      new Set(["running", "needs_input", "host:host-hidden", "host:host-a", "host:host-b"]),
    );
    expect(current.collapsedWorkspaceGroupKeys).toEqual(
      new Set(["running", "needs_input", "host:host-hidden"]),
    );
    expect(collapsed.collapsedProjectKeys).toBe(current.collapsedProjectKeys);
    expect(collapsed.collapsedPinned).toBe(true);

    const expanded = setWorkspaceGroupsCollapsed(collapsed, ["host:host-a"], false);

    expect(expanded.collapsedWorkspaceGroupKeys).toEqual(
      new Set(["running", "needs_input", "host:host-hidden", "host:host-b"]),
    );
    expect(expanded.collapsedProjectKeys).toBe(current.collapsedProjectKeys);
    expect(expanded.collapsedPinned).toBe(true);
  });

  it("returns the same state for empty or already applied bulk selections", () => {
    const current: CollapsedProjectsState = {
      collapsedProjectKeys: new Set(["project-a"]),
      collapsedWorkspaceGroupKeys: new Set(["host:host-a"]),
      collapsedPinned: false,
    };

    expect(setProjectsCollapsed(current, [], true)).toBe(current);
    expect(setProjectsCollapsed(current, [], false)).toBe(current);
    expect(setProjectsCollapsed(current, ["project-a", "project-a"], true)).toBe(current);
    expect(setProjectsCollapsed(current, ["project-b"], false)).toBe(current);
    expect(setWorkspaceGroupsCollapsed(current, [], true)).toBe(current);
    expect(setWorkspaceGroupsCollapsed(current, [], false)).toBe(current);
    expect(setWorkspaceGroupsCollapsed(current, ["host:host-a", "host:host-a"], true)).toBe(
      current,
    );
    expect(setWorkspaceGroupsCollapsed(current, ["host:host-b"], false)).toBe(current);
  });

  it("serializes and restores bulk host and project collapse preferences", () => {
    const projectKeys = ['host-project:["host-a","shared"]', 'host-project:["host-b","shared"]'];
    const current = togglePinnedCollapsed(emptyState());
    const projectsCollapsed = setProjectsCollapsed(current, projectKeys, true);
    const hostsCollapsed = setWorkspaceGroupsCollapsed(
      projectsCollapsed,
      ["running", "host:host-a", "host:host-b"],
      true,
    );
    const serialized = serializeCollapsedProjects(hostsCollapsed);
    const restored = mergePersistedCollapsedProjects(serialized, emptyState());

    expect(serialized.collapsedProjectKeys).toEqual(projectKeys);
    expect(serialized.collapsedWorkspaceGroupKeys).toEqual([
      "running",
      "host:host-a",
      "host:host-b",
    ]);
    expect(restored).toEqual(hostsCollapsed);
  });

  it("serializes collapsed project keys for preference storage", () => {
    const state: CollapsedProjectsState = {
      collapsedProjectKeys: new Set(["project-a", "project-b"]),
      collapsedWorkspaceGroupKeys: new Set(["running"]),
      collapsedPinned: true,
    };

    expect(serializeCollapsedProjects(state)).toEqual({
      collapsedProjectKeys: ["project-a", "project-b"],
      collapsedWorkspaceGroupKeys: ["running"],
      collapsedPinned: true,
    });
  });

  it("toggles and restores the pinned section collapse flag", () => {
    const toggled = togglePinnedCollapsed(emptyState());
    expect(toggled.collapsedPinned).toBe(true);

    const restored = mergePersistedCollapsedProjects({ collapsedPinned: true }, emptyState());
    expect(restored.collapsedPinned).toBe(true);
  });

  it("rejects the complete value when a persisted project key is invalid", () => {
    const restored = mergePersistedCollapsedProjects(
      { collapsedProjectKeys: ["project-a", "project-b", 42] },
      emptyState(),
    );

    expect(Array.from(restored.collapsedProjectKeys)).toEqual([]);
    expect(Array.from(restored.collapsedWorkspaceGroupKeys)).toEqual([]);
  });

  it("keeps the existing state object when persisted preferences do not change collapsed keys", () => {
    const currentState = emptyState();

    expect(mergePersistedCollapsedProjects(undefined, currentState)).toBe(currentState);
    expect(mergePersistedCollapsedProjects({}, currentState)).toBe(currentState);
    expect(mergePersistedCollapsedProjects({ collapsedProjectKeys: [] }, currentState)).toBe(
      currentState,
    );
  });
});
