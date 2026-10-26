import { describe, expect, it, vi } from "vitest";
import { reloadActiveBrowserOrWindow, setupApplicationMenu } from "./menu.js";

const electron = vi.hoisted(() => ({
  app: { name: "Paseo", on: vi.fn() },
  Menu: {
    buildFromTemplate: vi.fn((template: Electron.MenuItemConstructorOptions[]) => ({ template })),
    setApplicationMenu: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
}));

vi.mock("electron", () => electron);

function windowMenuForPlatform(platform: NodeJS.Platform): Electron.MenuItemConstructorOptions[] {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  if (!original) throw new Error("Process platform descriptor is unavailable");
  try {
    Object.defineProperty(process, "platform", { value: platform });
    setupApplicationMenu({ onNewWindow: vi.fn() });
  } finally {
    Object.defineProperty(process, "platform", original);
  }
  const template = electron.Menu.buildFromTemplate.mock.calls.at(-1)?.[0];
  const submenu = template?.find((item) => item.label === "Window")?.submenu;
  if (!Array.isArray(submenu)) throw new Error("Window menu is unavailable");
  return submenu;
}

describe("application window menu", () => {
  it.each(["win32", "linux"] as const)("reserves Alt+F4 for window close on %s", (platform) => {
    expect(windowMenuForPlatform(platform)).toEqual([
      { role: "minimize" },
      { role: "zoom" },
      { role: "close", accelerator: "Alt+F4" },
    ]);
  });

  it("preserves the macOS window menu", () => {
    expect(windowMenuForPlatform("darwin")).toEqual([
      { role: "minimize" },
      { role: "zoom" },
      { type: "separator" },
      { role: "front" },
    ]);
  });
});

class FakeWebContents {
  public readonly reloads: string[] = [];

  public constructor(public readonly id: number) {}

  public isLoadingMainFrame(): boolean {
    return false;
  }

  public stop(): void {
    this.reloads.push("stop");
  }

  public reload(): void {
    this.reloads.push("reload");
  }

  public reloadIgnoringCache(): void {
    this.reloads.push("force-reload");
  }
}

class BrowserReloads {
  public readonly firstWindow = { webContents: new FakeWebContents(101) };
  public readonly secondWindow = { webContents: new FakeWebContents(202) };
  public readonly firstBrowser = new FakeWebContents(11);
  public readonly secondBrowser = new FakeWebContents(22);
  public readonly resolvedHostWindowIds: number[] = [];

  public activeBrowserForHostWindow(hostWebContentsId: number): FakeWebContents | null {
    this.resolvedHostWindowIds.push(hostWebContentsId);
    return hostWebContentsId === 101 ? this.firstBrowser : this.secondBrowser;
  }
}

describe("reloadActiveBrowserOrWindow", () => {
  it("reloads only the active browser belonging to the supplied window", () => {
    const browserReloads = new BrowserReloads();

    reloadActiveBrowserOrWindow({
      win: browserReloads.firstWindow,
      getActiveBrowserContentsForHostWindow:
        browserReloads.activeBrowserForHostWindow.bind(browserReloads),
    });

    expect(browserReloads.resolvedHostWindowIds).toEqual([101]);
    expect(browserReloads.firstBrowser.reloads).toEqual(["reload"]);
    expect(browserReloads.secondBrowser.reloads).toEqual([]);
    expect(browserReloads.firstWindow.webContents.reloads).toEqual([]);
  });

  it("force reloads only the active browser belonging to the supplied window", () => {
    const browserReloads = new BrowserReloads();

    reloadActiveBrowserOrWindow({
      win: browserReloads.secondWindow,
      getActiveBrowserContentsForHostWindow:
        browserReloads.activeBrowserForHostWindow.bind(browserReloads),
      ignoreCache: true,
    });

    expect(browserReloads.resolvedHostWindowIds).toEqual([202]);
    expect(browserReloads.firstBrowser.reloads).toEqual([]);
    expect(browserReloads.secondBrowser.reloads).toEqual(["force-reload"]);
    expect(browserReloads.secondWindow.webContents.reloads).toEqual([]);
  });
});
