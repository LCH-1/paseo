import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  path: "/h/host/workspace/missing",
  hydrated: false,
  scope: {
    serverId: "host",
    projectId: "project",
    projectName: "Project",
    directory: "/project",
    windowId: "window",
  },
  workspaces: new Map<string, { projectId: string }>(),
}));
vi.mock("expo-router", () => ({ Redirect: () => null, usePathname: () => state.path }));
vi.mock("@/desktop/host", () => ({ getDesktopHost: () => ({ projectWindow: state.scope }) }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (s: unknown) => unknown) =>
    selector({
      sessions: { host: { workspaces: state.workspaces, hasHydratedWorkspaces: state.hydrated } },
    }),
}));
import { ProjectWindowBoundary } from "./boundary";
beforeEach(() => {
  state.hydrated = false;
  state.workspaces.clear();
  state.path = "/h/host/workspace/missing";
});
it("waits for the authoritative workspace directory before redirecting a missing route", () => {
  expect(ProjectWindowBoundary({ children: "content" })).toBeNull();
  state.hydrated = true;
  const result = ProjectWindowBoundary({ children: "content" });
  expect(result).not.toBeNull();
  expect((result as { props: { href: string } }).props.href).toContain("/new?");
});
it("preserves a valid project conversation", () => {
  state.workspaces.set("missing", { projectId: "project" });
  expect(ProjectWindowBoundary({ children: "content" })).toBe("content");
});
