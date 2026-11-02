import { describe, expect, it } from "vitest";
import { buildAbsoluteExplorerPath, resolveExplorerDownloadPath } from "./explorer-paths";

describe("buildAbsoluteExplorerPath", () => {
  it("builds a POSIX absolute path from a relative explorer path", () => {
    expect(
      buildAbsoluteExplorerPath({
        workspaceRoot: "/workspaces/paseo",
        entryPath: "packages/app/src/components/file-explorer-pane.tsx",
      }),
    ).toBe("/workspaces/paseo/packages/app/src/components/file-explorer-pane.tsx");
  });

  it("returns workspace root when entry path points to explorer root", () => {
    expect(
      buildAbsoluteExplorerPath({
        workspaceRoot: "/workspaces/paseo",
        entryPath: ".",
      }),
    ).toBe("/workspaces/paseo");
  });

  it("trims trailing separators from workspace root before joining", () => {
    expect(
      buildAbsoluteExplorerPath({
        workspaceRoot: "/workspaces/paseo/",
        entryPath: "README.md",
      }),
    ).toBe("/workspaces/paseo/README.md");
  });

  it("builds a Windows absolute path with backslash separators", () => {
    expect(
      buildAbsoluteExplorerPath({
        workspaceRoot: "C:\\repo\\paseo",
        entryPath: "packages/app/src/components/file-explorer-pane.tsx",
      }),
    ).toBe("C:\\repo\\paseo\\packages\\app\\src\\components\\file-explorer-pane.tsx");
  });

  it("passes through an already-absolute entry path", () => {
    expect(
      buildAbsoluteExplorerPath({
        workspaceRoot: "/workspaces/paseo",
        entryPath: "/tmp/another/location.txt",
      }),
    ).toBe("/tmp/another/location.txt");
  });
});

describe("resolveExplorerDownloadPath", () => {
  it.each([
    ["/srv/project/backend", "/srv/project/deployment.zip", "/srv/project", "deployment.zip"],
    ["/srv/project", "/deployment.zip", "/", "deployment.zip"],
    ["C:\\project", "D:\\exports\\배포 자료.zip", "D:/exports", "배포 자료.zip"],
    ["C:\\project", "D:\\deployment.zip", "D:/", "deployment.zip"],
    ["C:\\project", "\\\\server\\share\\deployment.zip", "//server/share", "deployment.zip"],
    ["/srv/project", "/srv/project/docs/report.zip", "/srv/project/docs", "report.zip"],
  ])("scopes %s → %s to the exact file parent", (workspace, file, cwd, path) => {
    expect(resolveExplorerDownloadPath(workspace, file)).toEqual({ cwd, path });
  });

  it.each(["docs/report.zip", "../deployment.zip", "~/deployment.zip", ".", "/", "D:/exports/"])(
    "preserves workspace scoping for relative or non-file target %s",
    (path) => {
      expect(resolveExplorerDownloadPath("/srv/project", path)).toEqual({
        cwd: "/srv/project",
        path,
      });
    },
  );
});
