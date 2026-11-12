import { describe, expect, it } from "vitest";
import {
  filterProjectWindowHosts,
  filterProjectWindowProjects,
  isProjectWindowWorkspace,
  projectWindowStorageKey,
} from "./state";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";

const scope = {
  serverId: "host",
  projectId: "project",
  projectName: "Project",
  directory: "/project",
  windowId: "one",
};

describe("project window state", () => {
  it("connects only its project host without changing the saved registry", () => {
    const hosts = [{ serverId: "host" }, { serverId: "other" }];
    expect(filterProjectWindowHosts(hosts, scope)).toEqual([hosts[0]]);
    expect(hosts).toHaveLength(2);
    expect(filterProjectWindowHosts(hosts, null)).toBe(hosts);
    expect(filterProjectWindowHosts(hosts, scope, "other")).toEqual(hosts);
    expect(filterProjectWindowHosts(hosts, { ...scope, serverId: "missing" })).toEqual([]);
  });

  it("keeps tabs, drafts, panels, filters, ordering and selection separate even for the same project", () => {
    for (const key of [
      "paseo-drafts",
      "new-workspace-tabs",
      "panel-state",
      "sidebar-view",
      "sidebar-project-workspace-order",
      "sidebar-collapsed-sections",
      "workspace-layout-state",
      "workspace-tab-groups",
      "paseo:last-workspace-route-selection",
    ]) {
      expect(projectWindowStorageKey(key, scope)).not.toBe(key);
      expect(projectWindowStorageKey(key, scope)).not.toBe(
        projectWindowStorageKey(key, { ...scope, windowId: "two" }),
      );
      expect(projectWindowStorageKey(key, null)).toBe(key);
    }
    expect(projectWindowStorageKey("settings", scope)).toBe("settings");
    expect(projectWindowStorageKey("host-registry", scope)).toBe("host-registry");
  });

  it("restricts equivalent projects to their selected host and never falls back to all projects", () => {
    const project: WorkspaceStructureProject = {
      viewKey: "equivalent",
      projectKey: "equivalent",
      projectName: "Project",
      projectKind: "git",
      iconWorkingDir: "/project",
      hosts: [
        {
          serverId: "host",
          projectId: "project",
          iconWorkingDir: "/project",
          worktreeSupport: "supported",
        },
        {
          serverId: "other",
          projectId: "project",
          iconWorkingDir: "/project",
          worktreeSupport: "supported",
        },
      ],
      workspaceKeys: ["host:w", "other:w"],
    };
    const filtered = filterProjectWindowProjects([project], scope);
    expect(filtered[0].hosts).toHaveLength(1);
    expect(filtered[0].workspaceKeys).toEqual(["host:w"]);
    expect(filterProjectWindowProjects([project], { ...scope, projectId: "missing" })).toEqual([]);
    expect(project.hosts).toHaveLength(2);
    expect(filterProjectWindowProjects([project], null)).toEqual([project]);
  });

  it("denies another project or host, including an unresolved workspace", () => {
    expect(isProjectWindowWorkspace("host", { projectId: "project" }, scope)).toBe(true);
    expect(isProjectWindowWorkspace("other", { projectId: "project" }, scope)).toBe(false);
    expect(isProjectWindowWorkspace("host", { projectId: "other" }, scope)).toBe(false);
    expect(isProjectWindowWorkspace("host", undefined, scope)).toBe(false);
    expect(isProjectWindowWorkspace("other", undefined, null)).toBe(true);
  });
});
