import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWindowStateStore } from "../settings/window-state";
import type { DesktopWindowSession, SavedDesktopWindow } from "../settings/window-session";
import { createWindowSessionManager } from "./window-session-manager";

import {
  applyMacWindowControlsUpdate,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  getMainWindowChromeOptions,
  readBadgeCount,
  readWindowChromeUpdate,
  readWindowTheme,
  resolveWindowBounds,
  setupWindowStatePersistence,
} from "./window-manager";

vi.mock("electron", () => ({
  app: new EventEmitter(),
  BrowserWindow: class extends EventEmitter {
    getNormalBounds = vi.fn(() => ({ x: 20, y: 30, width: 1000, height: 700 }));
    isMinimized = vi.fn(() => false);
    isFullScreen = vi.fn(() => false);
    isMaximized = vi.fn(() => false);
    isDestroyed = vi.fn(() => false);
  },
}));

class SessionTestWindow extends EventEmitter {
  url = "paseo://app/h/host/workspace/first";
  bounds = { x: 20, y: 30, width: 1000, height: 700 };
  webContents = Object.assign(new EventEmitter(), {
    getURL: () => this.url,
    isDestroyed: () => false,
  });
  isDestroyed = vi.fn(() => false);
  isMinimized = vi.fn(() => false);
  isFullScreen = vi.fn(() => false);
  isMaximized = vi.fn(() => false);
  getNormalBounds = () => this.bounds;
}

function sessionHarness() {
  let saved: DesktopWindowSession = { version: 1, restoreAtLogin: true, windows: [] };
  const saveSync = vi.fn((value: DesktopWindowSession) => {
    saved = structuredClone(value);
  });
  const onError = vi.fn();
  const manager = createWindowSessionManager({
    store: { load: async () => structuredClone(saved), saveSync },
    appUrl: "paseo://app",
    onError,
  });
  const entry = (id: string): SavedDesktopWindow => ({
    id,
    projectWindow: {
      windowId: id,
      serverId: "host",
      projectId: "project",
      projectName: "Project",
      directory: "/repo",
    },
    route: "/h/host/workspace/first",
    state: { x: 20, y: 30, width: 1000, height: 700, isMaximized: false },
  });
  return {
    manager,
    entry,
    saveSync,
    onError,
    saved: () => saved,
    seed: (value: DesktopWindowSession) => {
      saved = value;
    },
  };
}

describe("multi-window session persistence", () => {
  afterEach(() => vi.useRealTimers());

  it("restores project identities and independent window geometry without partial startup writes", async () => {
    vi.useFakeTimers();
    const h = sessionHarness();
    const one = h.entry("one"),
      two = h.entry("two");
    two.state = { x: -1500, y: 100, width: 900, height: 600, isMaximized: false };
    h.seed({ version: 1, restoreAtLogin: true, windows: [one, two] });
    await h.manager.load();
    await h.manager.restore(async (entry) => {
      const win = new SessionTestWindow();
      win.bounds = { ...entry.state, x: entry.state.x ?? 0, y: entry.state.y ?? 0 };
      h.manager.track(win, entry);
      expect(h.saveSync).not.toHaveBeenCalled();
    });
    expect(h.saved().windows).toEqual([one, two]);
    h.manager.beginQuit();
  });

  it("persists moves, routes and maximized geometry for each window independently", async () => {
    vi.useFakeTimers();
    const h = sessionHarness();
    const one = new SessionTestWindow(),
      two = new SessionTestWindow();
    h.manager.track(one, h.entry("one"));
    h.manager.track(two, h.entry("two"));
    two.bounds = { x: -1200, y: 80, width: 1100, height: 950 };
    two.isMaximized.mockReturnValue(true);
    two.url = "paseo://app/h/host/workspace/second?tab=other";
    two.emit("move");
    two.webContents.emit("did-navigate-in-page");
    await vi.advanceTimersByTimeAsync(400);
    expect(h.saved().windows[0].state.width).toBe(1000);
    expect(h.saved().windows[1]).toMatchObject({
      route: "/h/host/workspace/second?tab=other",
      state: { ...two.bounds, isMaximized: true },
    });
    two.isMinimized.mockReturnValue(true);
    two.isMaximized.mockReturnValue(false);
    two.bounds = { x: -32000, y: -32000, width: 1, height: 1 };
    two.emit("resize");
    await vi.advanceTimersByTimeAsync(400);
    expect(h.saved().windows[1].state.width).toBe(1100);
    expect(h.saved().windows[1].state.isMaximized).toBe(true);
    one.url = "https://external.example/private";
    one.webContents.emit("did-navigate");
    h.manager.beginQuit();
    expect(h.saved().windows[0].route).toBe("/h/host/workspace/first");
  });

  it("removes a manually closed sibling but retains the final window for next startup", () => {
    vi.useFakeTimers();
    const h = sessionHarness();
    const one = new SessionTestWindow(),
      two = new SessionTestWindow();
    expect(h.manager.hasOpenWindows()).toBe(false);
    h.manager.track(one, h.entry("one"));
    h.manager.track(two, h.entry("two"));
    expect(h.manager.hasOpenWindows()).toBe(true);
    one.emit("close");
    one.isDestroyed.mockReturnValue(true);
    one.emit("closed");
    expect(h.saved().windows.map((entry) => entry.id)).toEqual(["two"]);
    two.emit("close");
    two.isDestroyed.mockReturnValue(true);
    two.emit("closed");
    expect(h.manager.hasOpenWindows()).toBe(false);
    expect(h.saved().windows.map((entry) => entry.id)).toEqual(["two"]);
    h.manager.track(new SessionTestWindow(), h.entry("new"));
    h.manager.beginQuit();
    expect(h.saved().windows.map((entry) => entry.id)).toEqual(["new"]);
  });

  it("freezes the complete session before quit or reboot closes windows", async () => {
    vi.useFakeTimers();
    const h = sessionHarness();
    const one = new SessionTestWindow(),
      two = new SessionTestWindow();
    h.manager.track(one, h.entry("one"));
    h.manager.track(two, h.entry("two"));
    two.bounds = { x: 700, y: 40, width: 1200, height: 900 };
    two.emit("resize");
    h.manager.beginQuit();
    for (const win of [one, two]) {
      win.emit("close");
      win.isDestroyed.mockReturnValue(true);
      win.emit("closed");
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.saveSync).toHaveBeenCalledTimes(1);
    expect(h.saved().windows.map((entry) => entry.id)).toEqual(["one", "two"]);
    expect(h.saved().windows[1].state).toMatchObject(two.bounds);
  });

  it("continues restoring other windows after a failed creation and retains its retry entry", async () => {
    vi.useFakeTimers();
    const h = sessionHarness();
    h.seed({ version: 1, restoreAtLogin: false, windows: [h.entry("failed"), h.entry("good")] });
    await h.manager.load();
    await h.manager.restore(async (entry) => {
      if (entry.id === "failed") throw Error("Window failed to open");
      h.manager.track(new SessionTestWindow(), entry);
    });
    expect(
      h
        .saved()
        .windows.map((entry) => entry.id)
        .sort(),
    ).toEqual(["failed", "good"]);
    expect(h.onError).toHaveBeenCalledTimes(1);
    h.manager.beginQuit();
  });
});

describe("window state persistence", () => {
  const directories: string[] = [];

  afterEach(async () => {
    app.removeAllListeners("before-quit");
    vi.useRealTimers();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("keeps saving geometry after a close request is cancelled", async () => {
    vi.useFakeTimers();
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "paseo-window-persist-"));
    directories.push(userDataPath);
    const store = createWindowStateStore({ userDataPath });
    const save = vi.spyOn(store, "save");
    const win = new BrowserWindow();
    setupWindowStatePersistence(win, store);

    win.emit("close", { preventDefault: vi.fn() });
    const resized = { x: 150, y: 170, width: 1200, height: 800 };
    vi.mocked(win.getNormalBounds).mockReturnValue(resized);
    win.emit("resize");
    await vi.advanceTimersByTimeAsync(400);
    await save.mock.results[0].value;

    expect(await store.load()).toEqual({ ...resized, isMaximized: false });
  });

  it("flushes the latest geometry after the window is destroyed and clears pending saves", async () => {
    vi.useFakeTimers();
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "paseo-window-persist-"));
    directories.push(userDataPath);
    const store = createWindowStateStore({ userDataPath });
    const save = vi.spyOn(store, "save");
    const saveSync = vi.spyOn(store, "saveSync");
    const win = new BrowserWindow();
    setupWindowStatePersistence(win, store);
    win.emit("resize");
    win.emit("close", { preventDefault: vi.fn() });
    const finalBounds = { x: 200, y: 250, width: 1300, height: 900 };
    vi.mocked(win.getNormalBounds).mockReturnValue(finalBounds);
    win.emit("close", { preventDefault: vi.fn() });
    vi.mocked(win.isDestroyed).mockReturnValue(true);
    vi.mocked(win.getNormalBounds).mockImplementation(() => {
      throw new Error("Window has been destroyed");
    });
    win.emit("closed");
    await vi.advanceTimersByTimeAsync(400);

    expect(await store.load()).toEqual({ ...finalBounds, isMaximized: false });
    expect(saveSync).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(app.listenerCount("before-quit")).toBe(0);
  });

  it("flushes on app quit even when the window close event is bypassed", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "paseo-window-persist-"));
    directories.push(userDataPath);
    const store = createWindowStateStore({ userDataPath });
    const saveSync = vi.spyOn(store, "saveSync");
    const win = new BrowserWindow();
    setupWindowStatePersistence(win, store);
    const finalBounds = { x: 300, y: 350, width: 1400, height: 1000 };
    vi.mocked(win.getNormalBounds).mockReturnValue(finalBounds);

    app.emit("before-quit");
    win.emit("closed");

    expect(await store.load()).toEqual({ ...finalBounds, isMaximized: false });
    expect(saveSync).toHaveBeenCalledTimes(1);
  });
});

describe("window-manager", () => {
  describe("readBadgeCount", () => {
    it("returns valid non-negative integers", () => {
      expect(readBadgeCount(0)).toBe(0);
      expect(readBadgeCount(3)).toBe(3);
    });

    it("falls back to zero for invalid payloads", () => {
      expect(readBadgeCount(undefined)).toBe(0);
      expect(readBadgeCount(null)).toBe(0);
      expect(readBadgeCount(Number.NaN)).toBe(0);
      expect(readBadgeCount(Number.POSITIVE_INFINITY)).toBe(0);
      expect(readBadgeCount(-1)).toBe(0);
      expect(readBadgeCount(1.5)).toBe(0);
      expect(readBadgeCount("2")).toBe(0);
      expect(readBadgeCount({ count: 2 })).toBe(0);
    });
  });

  describe("readWindowTheme", () => {
    it("accepts supported title bar themes", () => {
      expect(readWindowTheme("light")).toBe("light");
      expect(readWindowTheme("dark")).toBe("dark");
    });

    it("rejects invalid title bar themes", () => {
      expect(readWindowTheme(undefined)).toBeNull();
      expect(readWindowTheme("auto")).toBeNull();
      expect(readWindowTheme("system")).toBeNull();
    });
  });

  describe("readWindowChromeUpdate", () => {
    it("accepts partial runtime overlay updates", () => {
      expect(
        readWindowChromeUpdate({
          backgroundColor: "#181B1A",
          trafficLightOffsetY: -5,
        }),
      ).toEqual({
        backgroundColor: "#181B1A",
        trafficLightOffsetY: -5,
      });
    });

    it("rejects empty and invalid payloads", () => {
      expect(readWindowChromeUpdate(undefined)).toBeNull();
      expect(readWindowChromeUpdate({})).toBeNull();
      expect(readWindowChromeUpdate({ backgroundColor: 12 })).toBeNull();
      expect(readWindowChromeUpdate({ trafficLightOffsetY: -11 })).toBeNull();
    });

    it("preserves fractional traffic-light offsets", () => {
      expect(readWindowChromeUpdate({ trafficLightOffsetY: 1.5 })).toEqual({
        trafficLightOffsetY: 1.5,
      });
    });
  });

  describe("applyMacWindowControlsUpdate", () => {
    it("uses the focus and normal traffic-light positions", () => {
      const setWindowButtonPosition = vi.fn();

      applyMacWindowControlsUpdate({
        win: { setWindowButtonPosition },
        update: { trafficLightOffsetY: -5 },
      });
      applyMacWindowControlsUpdate({
        win: { setWindowButtonPosition },
        update: { trafficLightOffsetY: 0.5 },
      });

      expect(setWindowButtonPosition).toHaveBeenNthCalledWith(1, { x: 16, y: 9 });
      expect(setWindowButtonPosition).toHaveBeenNthCalledWith(2, { x: 16, y: 14.5 });
    });
  });

  describe("getMainWindowChromeOptions", () => {
    it("uses renderer-painted controls on windows", () => {
      expect(
        getMainWindowChromeOptions({
          mode: "custom-windows",
        }),
      ).toEqual({
        frame: false,
        autoHideMenuBar: true,
      });
    });

    it("uses renderer-painted controls on linux", () => {
      expect(
        getMainWindowChromeOptions({
          mode: "custom-linux",
        }),
      ).toEqual({
        frame: false,
        autoHideMenuBar: true,
      });
    });

    it("keeps the mac traffic-light path separate", () => {
      expect(
        getMainWindowChromeOptions({
          mode: "native-mac",
        }),
      ).toEqual({
        titleBarStyle: "hidden",
        titleBarOverlay: true,
        trafficLightPosition: { x: 16, y: 14 },
      });
    });
  });

  describe("resolveWindowBounds", () => {
    it("falls back to the default size when no state is saved", () => {
      expect(resolveWindowBounds(null)).toEqual({
        width: DEFAULT_WINDOW_WIDTH,
        height: DEFAULT_WINDOW_HEIGHT,
      });
    });

    it("restores the full size and position", () => {
      expect(
        resolveWindowBounds({ x: 120, y: 80, width: 1024, height: 720, isMaximized: false }),
      ).toEqual({ width: 1024, height: 720, x: 120, y: 80 });
    });

    it("omits the position when only the size was persisted", () => {
      expect(resolveWindowBounds({ width: 1024, height: 720, isMaximized: true })).toEqual({
        width: 1024,
        height: 720,
      });
    });
  });
});
