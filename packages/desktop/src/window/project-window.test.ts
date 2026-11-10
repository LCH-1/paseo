import { describe, expect, it } from "vitest";
import {
  createProjectWindowScope,
  parseProjectWindowTarget,
  projectWindowArgument,
  projectWindowRoute,
  resolveProjectWindowTitle,
  selectNotificationWindow,
  readNotificationProject,
} from "./project-window.js";

const target = {
  serverId: "host #1",
  projectId: "project&2",
  projectName: "한글 프로젝트",
  directory: "C:\\work\\a b",
};

describe("project windows", () => {
  it("routes a notification to its host and project instead of its sender", () => {
    const windows = [
      { id: 1, projectWindow: { ...target, serverId: "other-host" } },
      { id: 2, projectWindow: { ...target, projectId: "other-project" } },
      { id: 3, projectWindow: target },
    ];
    expect(selectNotificationWindow(windows, 2, target)).toEqual(windows[2]);
    expect(selectNotificationWindow(windows.slice(0, 2), 2, target)).toBeNull();
  });
  it("prefers the sending window only when it belongs to the same project", () => {
    const windows = [
      { id: 1, projectWindow: target },
      { id: 2, projectWindow: target },
    ];
    expect(selectNotificationWindow(windows, 2, target)).toEqual(windows[1]);
  });
  it("uses an integrated window when the notification project has no open window", () => {
    const windows = [
      { id: 1, projectWindow: { ...target, projectId: "unrelated" } },
      { id: 2, projectWindow: null },
      { id: 3, projectWindow: null },
    ];
    expect(selectNotificationWindow(windows, 1, target)).toEqual(windows[1]);
    expect(selectNotificationWindow(windows, 3, target)).toEqual(windows[2]);
    expect(selectNotificationWindow(windows.slice(0, 1), 1, target)).toBeNull();
  });
  it("keeps untargeted notifications out of unrelated project windows", () => {
    const windows = [
      { id: 1, projectWindow: target },
      { id: 2, projectWindow: null },
    ];
    expect(selectNotificationWindow(windows, 1, null)).toEqual(windows[1]);
    expect(selectNotificationWindow(windows.slice(0, 1), 1, null)).toBeNull();
  });
  it("validates the captured project against the notification host", () => {
    expect(readNotificationProject({ serverId: target.serverId, projectWindow: target })).toEqual(
      target,
    );
    expect(readNotificationProject({ serverId: "other-host", projectWindow: target })).toBeNull();
    expect(
      readNotificationProject({
        serverId: target.serverId,
        projectWindow: { ...target, directory: null },
      }),
    ).toBeNull();
    expect(readNotificationProject(undefined)).toBeNull();
  });
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
