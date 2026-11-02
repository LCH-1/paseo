import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWindowStateStore } from "../settings/window-state";

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
