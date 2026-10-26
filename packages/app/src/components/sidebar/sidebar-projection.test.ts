import { i18n } from "@/i18n/i18next";
import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import {
  buildSidebarHostProjectGroups,
  filterSidebarProjectHosts,
  sidebarHostGroupKey,
  sidebarHostProjectKey,
} from "./host-project-groups";
import { buildSidebarProjection } from "./sidebar-projection";

function makeWorkspace(
  id: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done",
  labels: string[] = [],
  projectViewKey = "project",
  serverId = "srv",
) {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `${serverId}:${id}`,
    serverId,
    workspaceId: id,
    projectViewKey,
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
  const entry: SidebarWorkspaceEntry = {
    ...placement,
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    statusBucket,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    labels,
  };
  return { placement, entry };
}

function makeProjectHost(serverId: string, projectId: string) {
  return {
    serverId,
    projectId,
    iconWorkingDir: `/${serverId}/${projectId}`,
    worktreeSupport: "supported" as const,
  };
}

function makeProject(
  workspaces: SidebarWorkspacePlacement[],
  viewKey = "project",
): SidebarProjectEntry {
  return {
    viewKey,
    projectName: "Project",
    projectKind: "git",
    iconWorkingDir: `/repo/${viewKey}`,
    hosts: [makeProjectHost("srv", viewKey)],
    workspaces,
  };
}

function projectionInput(options?: { groupMode?: SidebarGroupMode; pinnedCollapsed?: boolean }) {
  const pinned = makeWorkspace("pinned", "running");
  const unpinned = makeWorkspace("unpinned", "needs_input");
  return {
    projects: [makeProject([pinned.placement, unpinned.placement])],
    serverIds: ["srv"],
    pinnedKeys: {
      pinnedWorkspaceKeys: [pinned.placement.workspaceKey],
      pinnedAtByKey: { [pinned.placement.workspaceKey]: "2026-07-12T12:00:00.000Z" },
    },
    pinnedWorkspaceOrder: [],
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
    groupMode: options?.groupMode ?? ("project" as const),
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
    t: i18n.t,
  };
}

/**
 * Two projects, one workspace each, both labelled — so every grouping mode puts rows from more
 * than one project on screen, and a mode that asked for fewer icons than it renders would show it.
 */
function twoProjectInput(groupMode: SidebarGroupMode) {
  const first = makeWorkspace("first", "running", ["Urgent"], "project");
  const second = makeWorkspace("second", "needs_input", ["Backend"], "other-project");
  return {
    ...projectionInput({ groupMode }),
    projects: [makeProject([first.placement]), makeProject([second.placement], "other-project")],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map([
      [first.entry.workspaceKey, first.entry],
      [second.entry.workspaceKey, second.entry],
    ]),
    projectNamesByViewKey: new Map([
      ["project", "Project"],
      ["other-project", "Other project"],
    ]),
  };
}

function twoHostInput() {
  const first = makeWorkspace("first", "running", [], "project", "srv-a");
  const second = makeWorkspace("second", "done", [], "other-project", "srv-a");
  const third = makeWorkspace("third", "needs_input", [], "project", "srv-b");
  const sharedProject = {
    ...makeProject([first.placement, third.placement]),
    hosts: [makeProjectHost("srv-a", "project"), makeProjectHost("srv-b", "project")],
  };
  const otherProject = {
    ...makeProject([second.placement], "other-project"),
    hosts: [makeProjectHost("srv-a", "other-project")],
  };
  const emptyProject = {
    ...makeProject([], "empty-project"),
    hosts: [makeProjectHost("srv-b", "empty-project")],
  };
  return {
    ...projectionInput({ groupMode: "host" }),
    projects: [otherProject, sharedProject, emptyProject],
    serverIds: ["srv-b", "empty-host", "srv-a"],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map([
      [first.entry.workspaceKey, first.entry],
      [second.entry.workspaceKey, second.entry],
      [third.entry.workspaceKey, third.entry],
    ]),
    projectNamesByViewKey: new Map([
      ["project", "Project"],
      ["other-project", "Other project"],
      ["empty-project", "Empty project"],
    ]),
  };
}

describe("filterSidebarProjectHosts", () => {
  it("removes a host whose workspaces were all filtered from a shared project", () => {
    const first = makeWorkspace("first", "running", [], "project", "srv-a");
    const second = makeWorkspace("second", "done", [], "project", "srv-b");
    const project = {
      ...makeProject([first.placement, second.placement]),
      hosts: [makeProjectHost("srv-a", "project"), makeProjectHost("srv-b", "project")],
    };
    const workspaces = [first.placement];
    const hosts = filterSidebarProjectHosts({ project, workspaces, keepEmptyProjects: true });
    const groups = buildSidebarHostProjectGroups({
      projects: [{ ...project, hosts, workspaces }],
      serverIds: ["srv-b", "srv-a"],
    });

    expect(groups.map((group) => group.serverId)).toEqual(["srv-a"]);
    expect(project.hosts).toHaveLength(2);
  });

  it("preserves originally empty host placements only while empty projects are allowed", () => {
    const first = makeWorkspace("first", "running", [], "project", "srv-a");
    const project = {
      ...makeProject([first.placement]),
      hosts: [makeProjectHost("srv-a", "project"), makeProjectHost("srv-b", "project")],
    };
    const keepEmptyHosts = filterSidebarProjectHosts({
      project,
      workspaces: [first.placement],
      keepEmptyProjects: true,
    });
    const labelFilteredHosts = filterSidebarProjectHosts({
      project,
      workspaces: [first.placement],
      keepEmptyProjects: false,
    });

    expect(keepEmptyHosts.map((host) => host.serverId)).toEqual(["srv-a", "srv-b"]);
    expect(labelFilteredHosts.map((host) => host.serverId)).toEqual(["srv-a"]);
  });
});

describe("buildSidebarHostProjectGroups", () => {
  it("splits shared projects by host while retaining host and project order", () => {
    const input = twoHostInput();
    const groups = buildSidebarHostProjectGroups(input);
    const projectKeysByHost: string[][] = [];
    for (const group of groups) {
      projectKeysByHost.push(group.projects.map((project) => project.viewKey));
    }

    expect(groups.map((group) => group.serverId)).toEqual(["srv-b", "srv-a"]);
    expect(projectKeysByHost).toEqual([
      ["project", "empty-project"],
      ["other-project", "project"],
    ]);
    for (const group of groups) {
      for (const project of group.projects) {
        expect(project.hosts.map((host) => host.serverId)).toEqual([group.serverId]);
        expect(project.iconWorkingDir).toBe(`/${group.serverId}/${project.viewKey}`);
        expect(project.workspaces.every((workspace) => workspace.serverId === group.serverId)).toBe(
          true,
        );
      }
    }
    expect(groups[0]?.projects[0]?.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      "third",
    ]);
    expect(groups[1]?.projects[1]?.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      "first",
    ]);
    expect(input.projects[1]?.hosts).toHaveLength(2);
    expect(input.projects[1]?.workspaces).toHaveLength(2);
  });

  it("keeps empty projects and omits hosts without any project placement", () => {
    const groups = buildSidebarHostProjectGroups(twoHostInput());

    expect(groups[0]?.projects[1]?.viewKey).toBe("empty-project");
    expect(groups[0]?.projects[1]?.workspaces).toEqual([]);
    expect(groups.some((group) => group.serverId === "empty-host")).toBe(false);
  });

  it("includes only the supplied hosts and keeps collapse keys independent", () => {
    const input = twoHostInput();
    const groups = buildSidebarHostProjectGroups({ ...input, serverIds: ["srv-a"] });

    expect(groups.map((group) => group.serverId)).toEqual(["srv-a"]);
    expect(sidebarHostProjectKey({ serverId: "srv-a", projectViewKey: "project" })).not.toBe(
      sidebarHostProjectKey({ serverId: "srv-b", projectViewKey: "project" }),
    );
    expect(sidebarHostProjectKey({ serverId: "a:b", projectViewKey: "c" })).not.toBe(
      sidebarHostProjectKey({ serverId: "a", projectViewKey: "b:c" }),
    );
  });
});

describe("buildSidebarProjection", () => {
  // The rule that outlived the bug it was written for: a project icon is fetched per project, so
  // whatever a mode groups by, the rows it produces can only reference projects already covered.
  for (const groupMode of ["project", "status", "host"] as const) {
    it(`covers every row ${groupMode} grouping renders with a project icon target`, () => {
      const projection = buildSidebarProjection(twoProjectInput(groupMode));
      const covered = new Set(projection.projectIconTargets.map((target) => target.projectViewKey));

      // Every leading visual the sidebar can paint from this projection: pinned rows, grouped
      // rows, project headers and the rows under them.
      const renderedProjectViewKeys = new Set<string>();
      for (const entry of projection.pinnedGroups.pinnedChats) {
        renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const group of projection.workspaceGroups) {
        for (const entry of group.rows) renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const project of projection.pinnedGroups.unpinnedProjects) {
        renderedProjectViewKeys.add(project.viewKey);
        for (const entry of project.workspaces) renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const host of projection.hostGroups) {
        for (const project of host.projects) {
          renderedProjectViewKeys.add(project.viewKey);
          for (const entry of project.workspaces) renderedProjectViewKeys.add(entry.projectViewKey);
        }
      }

      expect([...renderedProjectViewKeys].sort()).toEqual(["other-project", "project"]);
      expect([...renderedProjectViewKeys].filter((viewKey) => !covered.has(viewKey))).toEqual([]);
    });
  }

  it("uses one pin-aware projection for project rows and shortcut order", () => {
    const projection = buildSidebarProjection(projectionInput());

    expect(projection.pinnedGroups.pinnedChats.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
    ]);
    const remainingProject = projection.pinnedGroups.unpinnedProjects[0];
    expect(remainingProject?.workspaces.map((entry) => entry.workspaceId)).toEqual(["unpinned"]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("keeps pinned chats above status groups and removes them from those groups", () => {
    const projection = buildSidebarProjection(projectionInput({ groupMode: "status" }));

    expect(projection.workspaceGroups.map((group) => group.key)).toEqual(["needs_input"]);
    expect(projection.workspaceGroups[0]?.rows.map((entry) => entry.workspaceId)).toEqual([
      "unpinned",
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("does not number pinned chats while the pinned section is collapsed", () => {
    const projection = buildSidebarProjection(
      projectionInput({ groupMode: "status", pinnedCollapsed: true }),
    );

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("walks host groups in their rendered host and project order", () => {
    const projection = buildSidebarProjection(twoHostInput());

    expect(projection.workspaceGroups).toEqual([]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv-b", workspaceId: "third" },
      { serverId: "srv-a", workspaceId: "second" },
      { serverId: "srv-a", workspaceId: "first" },
    ]);
  });

  it("keeps pinned workspaces above hosts without repeating them under projects", () => {
    const input = twoHostInput();
    const pinnedKey = "srv-a:second";
    const projection = buildSidebarProjection({
      ...input,
      pinnedKeys: {
        pinnedWorkspaceKeys: [pinnedKey],
        pinnedAtByKey: { [pinnedKey]: "2026-10-26T12:00:00.000Z" },
      },
    });

    expect(projection.pinnedGroups.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual([
      pinnedKey,
    ]);
    expect(projection.hostGroups[1]?.projects[0]?.workspaces).toEqual([]);
    const hostProjects = projection.hostGroups.flatMap((group) => group.projects);
    const hostWorkspaces = hostProjects.flatMap((project) => project.workspaces);
    const hostWorkspaceKeys = hostWorkspaces.map((workspace) => workspace.workspaceKey);
    expect(hostWorkspaceKeys).not.toContain(pinnedKey);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv-a", workspaceId: "second" },
      { serverId: "srv-b", workspaceId: "third" },
      { serverId: "srv-a", workspaceId: "first" },
    ]);
  });

  it("excludes collapsed hosts and host-scoped projects from shortcuts", () => {
    const input = twoHostInput();
    const projection = buildSidebarProjection({
      ...input,
      collapsedWorkspaceGroupKeys: new Set([sidebarHostGroupKey("srv-b")]),
      collapsedProjectKeys: new Set([
        sidebarHostProjectKey({ serverId: "srv-a", projectViewKey: "other-project" }),
      ]),
    });

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv-a", workspaceId: "first" },
    ]);
    expect(projection.shortcutModel.shortcutIndexByWorkspaceKey.get("srv-a:first")).toBe(1);
  });

  it("collapses one host's shared project independently of its other host", () => {
    const input = twoHostInput();
    const projection = buildSidebarProjection({
      ...input,
      collapsedProjectKeys: new Set([
        sidebarHostProjectKey({ serverId: "srv-b", projectViewKey: "project" }),
        "project",
      ]),
    });

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv-a", workspaceId: "second" },
      { serverId: "srv-a", workspaceId: "first" },
    ]);
  });
});
