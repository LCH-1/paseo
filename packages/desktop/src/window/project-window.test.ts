import { describe, expect, it } from "vitest";
import {
  createProjectWindowScope,
  parseProjectWindowTarget,
  projectWindowArgument,
  projectWindowRoute,
  resolveProjectWindowTitle,
} from "./project-window.js";

const target = {
  serverId: "host #1",
  projectId: "project&2",
  projectName: "한글 프로젝트",
  directory: "C:\\work\\a b",
};

describe("project windows", () => {
  it.each(["", "  ", "Paseo", "Workspace"])(
    "keeps the project title for an empty page title %j",
    (title) => {
      expect(resolveProjectWindowTitle({ ...target, windowId: "window" }, title, "Paseo")).toBe(
        "한글 프로젝트 · Paseo",
      );
    },
  );

  it("preserves a meaningful conversation or file title", () => {
    expect(resolveProjectWindowTitle({ ...target, windowId: "window" }, "Review PR", "Paseo")).toBe(
      "Review PR",
    );
  });
  it("isolates two windows for the same project and preserves the target through the native argument", () => {
    const first = createProjectWindowScope(target);
    const second = createProjectWindowScope(target);
    expect(first.windowId).not.toBe(second.windowId);
    const argument = projectWindowArgument(first);
    expect(JSON.parse(decodeURIComponent(argument.split("=")[1]))).toEqual(first);
    const route = new URL(projectWindowRoute(first), "https://paseo.local");
    expect(route.pathname).toBe("/new");
    expect(Object.fromEntries(route.searchParams)).toEqual({
      serverId: target.serverId,
      projectId: target.projectId,
      dir: target.directory,
      name: target.projectName,
    });
  });

  it.each([
    null,
    {},
    { ...target, serverId: " " },
    { ...target, projectId: 2 },
    { ...target, directory: "x".repeat(8193) },
  ])("rejects invalid IPC input %j", (value) => {
    expect(() => parseProjectWindowTarget(value)).toThrow();
  });
});
