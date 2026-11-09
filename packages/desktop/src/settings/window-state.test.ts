import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWindowSessionStore, type SavedDesktopWindow } from "./window-session";
import { afterEach, describe, expect, it } from "vitest";

import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type WindowState,
  type WorkArea,
  clampWindowStateToWorkAreas,
  createWindowStateStore,
} from "./window-state";

async function createTempUserDataDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "paseo-window-state-"));
}

function stateFilePath(userDataPath: string): string {
  return path.join(userDataPath, "window-state.json");
}

const PRIMARY: WorkArea = { x: 0, y: 0, width: 1920, height: 1080 };

describe("desktop window sessions", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  function savedWindow(id: string): SavedDesktopWindow {
    return {
      id,
      projectWindow: {
        windowId: id,
        serverId: "host",
        projectId: "project",
        projectName: "프로젝트",
        directory: "/repo",
      },
      route: "/h/host/workspace/workspace?tab=agent",
      state: { x: -1800, y: 100, width: 1200, height: 800, isMaximized: true },
    };
  }

  it("restores separate identities for two windows of the same project", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.push(userDataPath);
    const session = {
      version: 1 as const,
      restoreAtLogin: true,
      windows: [savedWindow("one"), savedWindow("two")],
    };
    createWindowSessionStore(userDataPath).saveSync(session);
    expect(await createWindowSessionStore(userDataPath).load()).toEqual(session);
    expect(await readdir(userDataPath)).toEqual(["window-session.json"]);
  });

  it("discards unsafe routes and duplicate or mismatched identities without losing good windows", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.push(userDataPath);
    await writeFile(
      path.join(userDataPath, "window-session.json"),
      JSON.stringify({
        version: 1,
        restoreAtLogin: true,
        windows: [
          savedWindow("one"),
          savedWindow("one"),
          { ...savedWindow("two"), route: "//external.example" },
          { ...savedWindow("three"), route: "/\\external.example" },
          { ...savedWindow("four"), projectWindow: savedWindow("one").projectWindow },
          { ...savedWindow("normal"), projectWindow: null },
        ],
      }),
    );
    expect(
      (await createWindowSessionStore(userDataPath).load()).windows.map((window) => window.id),
    ).toEqual(["one", "normal"]);
  });

  it("starts clean on a first launch or malformed session document", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.push(userDataPath);
    const store = createWindowSessionStore(userDataPath);
    expect((await store.load()).windows).toEqual([]);
    await writeFile(path.join(userDataPath, "window-session.json"), "{broken");
    expect(await store.load()).toEqual({ version: 1, restoreAtLogin: false, windows: [] });
  });
});

describe("window-state store", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...directories].map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
    directories.clear();
  });

  it("returns null when no state has been persisted yet", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createWindowStateStore({ userDataPath });

    expect(await store.load()).toBeNull();
  });

  it("round-trips a saved state through disk", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createWindowStateStore({ userDataPath });

    const state: WindowState = { x: 100, y: 200, width: 1000, height: 700, isMaximized: false };
    await store.save(state);

    expect(await store.load()).toEqual(state);
  });

  it("uses a device startup size on first launch and after saving another size", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const preferencePath = path.join(userDataPath, "startup-window-size.json");
    await writeFile(preferencePath, JSON.stringify({ width: 1615, height: 1215 }));
    const store = createWindowStateStore({ userDataPath });
    expect(await store.load()).toEqual({ width: 1615, height: 1215, isMaximized: false });
    await store.save({ x: 20, y: 30, width: 1200, height: 800, isMaximized: true });
    expect(await store.load()).toEqual({
      x: 20,
      y: 30,
      width: 1615,
      height: 1215,
      isMaximized: false,
    });
    expect(JSON.parse(await readFile(preferencePath, "utf8"))).toEqual({
      width: 1615,
      height: 1215,
    });
    await rm(preferencePath);
    expect(await store.load()).toEqual({
      x: 20,
      y: 30,
      width: 1200,
      height: 800,
      isMaximized: true,
    });
  });

  it.each(["{ invalid json", '{"width":"1615","height":1215}', '{"width":-1,"height":1215}'])(
    "ignores an invalid startup size without losing saved geometry: %s",
    async (contents) => {
      const userDataPath = await createTempUserDataDir();
      directories.add(userDataPath);
      const store = createWindowStateStore({ userDataPath });
      const saved = { x: 10, y: 20, width: 1100, height: 750, isMaximized: true };
      await store.save(saved);
      await writeFile(path.join(userDataPath, "startup-window-size.json"), contents);
      expect(await store.load()).toEqual(saved);
    },
  );

  it("persists the maximized flag", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createWindowStateStore({ userDataPath });

    await store.save({ x: 0, y: 0, width: 1280, height: 800, isMaximized: true });

    expect((await store.load())?.isMaximized).toBe(true);
  });

  it("leaves no temp files behind after an async save", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createWindowStateStore({ userDataPath });

    await store.save({ x: 10, y: 10, width: 800, height: 600, isMaximized: false });

    expect(await readdir(userDataPath)).toEqual(["window-state.json"]);
  });

  it("writes atomically and synchronously via saveSync", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createWindowStateStore({ userDataPath });

    store.saveSync({ x: 5, y: 6, width: 900, height: 650, isMaximized: false });

    const persisted = JSON.parse(await readFile(stateFilePath(userDataPath), "utf8")) as {
      version: number;
      state: WindowState;
    };
    expect(persisted.state).toEqual({ x: 5, y: 6, width: 900, height: 650, isMaximized: false });
    expect(await readdir(userDataPath)).toEqual(["window-state.json"]);
  });

  it("returns null for corrupted JSON instead of throwing", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(stateFilePath(userDataPath), "{ not valid json");
    const store = createWindowStateStore({ userDataPath });

    expect(await store.load()).toBeNull();
  });

  it("returns null when persisted state lacks usable dimensions", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      stateFilePath(userDataPath),
      JSON.stringify({ version: 1, state: { isMaximized: true } }),
    );
    const store = createWindowStateStore({ userDataPath });

    expect(await store.load()).toBeNull();
  });

  it("clamps persisted dimensions up to the minimum size", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      stateFilePath(userDataPath),
      JSON.stringify({ version: 1, state: { width: 100, height: 50, isMaximized: false } }),
    );
    const store = createWindowStateStore({ userDataPath });

    const loaded = await store.load();
    expect(loaded?.width).toBe(MIN_WINDOW_WIDTH);
    expect(loaded?.height).toBe(MIN_WINDOW_HEIGHT);
  });

  it("drops non-finite coordinates while keeping valid dimensions", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      stateFilePath(userDataPath),
      JSON.stringify({
        version: 1,
        state: { x: "nope", y: null, width: 1000, height: 700, isMaximized: false },
      }),
    );
    const store = createWindowStateStore({ userDataPath });

    const loaded = await store.load();
    expect(loaded).toEqual({ width: 1000, height: 700, isMaximized: false });
  });
});

describe("clampWindowStateToWorkAreas", () => {
  it("keeps a state fully inside the primary display unchanged", () => {
    const state: WindowState = { x: 100, y: 100, width: 1000, height: 700, isMaximized: false };
    expect(clampWindowStateToWorkAreas(state, [PRIMARY])).toEqual(state);
  });

  it("keeps valid negative coordinates from a left-side secondary monitor", () => {
    const left: WorkArea = { x: -1920, y: 0, width: 1920, height: 1080 };
    const state: WindowState = { x: -1800, y: 80, width: 1000, height: 700, isMaximized: false };

    expect(clampWindowStateToWorkAreas(state, [left, PRIMARY])).toEqual(state);
  });

  it("drops x/y when the window does not meaningfully intersect any display", () => {
    const state: WindowState = { x: 5000, y: 5000, width: 1000, height: 700, isMaximized: false };

    const clamped = clampWindowStateToWorkAreas(state, [PRIMARY]);

    expect(clamped.x).toBeUndefined();
    expect(clamped.y).toBeUndefined();
    expect(clamped.width).toBe(1000);
    expect(clamped.height).toBe(700);
  });

  it("shrinks an oversized window to the target work area", () => {
    const state: WindowState = { x: 0, y: 0, width: 5000, height: 4000, isMaximized: false };

    const clamped = clampWindowStateToWorkAreas(state, [PRIMARY]);

    expect(clamped.width).toBe(PRIMARY.width);
    expect(clamped.height).toBe(PRIMARY.height);
  });

  it("repositions an oversized edge window so it stays fully on-screen after shrinking", () => {
    // Saved near the right edge and larger than the display: a naive clamp would
    // keep x=1820 and shrink to 1920 wide, leaving the window mostly off-screen.
    const state: WindowState = { x: 1820, y: 0, width: 3000, height: 2000, isMaximized: false };

    const clamped = clampWindowStateToWorkAreas(state, [PRIMARY]);

    expect(clamped.width).toBe(PRIMARY.width);
    expect(clamped.height).toBe(PRIMARY.height);
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(0);
  });

  it("drops position when there are no known displays", () => {
    const state: WindowState = { x: 100, y: 100, width: 1000, height: 700, isMaximized: false };

    const clamped = clampWindowStateToWorkAreas(state, []);

    expect(clamped.x).toBeUndefined();
    expect(clamped.y).toBeUndefined();
    expect(clamped.width).toBe(1000);
    expect(clamped.height).toBe(700);
  });

  it("preserves the maximized flag through clamping", () => {
    const state: WindowState = { x: 100, y: 100, width: 1000, height: 700, isMaximized: true };

    expect(clampWindowStateToWorkAreas(state, [PRIMARY]).isMaximized).toBe(true);
  });
});
