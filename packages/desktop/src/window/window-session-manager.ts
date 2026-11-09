import type {
  DesktopWindowSession,
  SavedDesktopWindow,
  WindowSessionStore,
} from "../settings/window-session.js";
import { isWindowSessionRoute } from "../settings/window-session.js";

interface WindowSessionContents {
  isDestroyed(): boolean;
  getURL(): string;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

export interface SessionWindow {
  webContents: WindowSessionContents;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  isMaximized(): boolean;
  getNormalBounds(): { x: number; y: number; width: number; height: number };
  on(event: string, listener: () => void): unknown;
}

export function createWindowSessionManager(input: {
  store: WindowSessionStore;
  appUrl: string;
  onError(error: unknown): void;
}) {
  const origin = new URL(input.appUrl);
  const active = new Map<string, { window: SessionWindow; entry: SavedDesktopWindow }>();
  const pendingRestores = new Map<string, SavedDesktopWindow>();
  let session: DesktopWindowSession = { version: 1, restoreAtLogin: false, windows: [] };
  let restoring = false;
  let quitting = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function capture() {
    for (const item of active.values()) {
      const win = item.window;
      if (win.isDestroyed()) continue;
      if (!win.isMinimized() && !win.isFullScreen()) {
        item.entry.state = { ...win.getNormalBounds(), isMaximized: win.isMaximized() };
      }
      if (win.webContents.isDestroyed()) continue;
      const url = win.webContents.getURL();
      if (!url) continue;
      const parsed = new URL(url);
      if (
        parsed.protocol !== origin.protocol ||
        parsed.hostname !== origin.hostname ||
        parsed.port !== origin.port
      )
        continue;
      const route = parsed.pathname + parsed.search + parsed.hash;
      if (isWindowSessionRoute(route)) item.entry.route = route;
    }
  }

  function persist() {
    clearTimer();
    if (restoring || quitting) return;
    capture();
    // Closing the final window is also an application exit on Windows. Preserve
    // its pre-close snapshot, while explicitly closed sibling windows stay gone.
    if (active.size === 0) return;
    session = {
      ...session,
      windows: [...[...active.values()].map((item) => item.entry), ...pendingRestores.values()],
    };
    try {
      input.store.saveSync(session);
    } catch (error) {
      input.onError(error);
    }
  }

  function schedule() {
    if (quitting) return;
    capture();
    clearTimer();
    timer = setTimeout(persist, 400);
  }

  return {
    hasOpenWindows() {
      return [...active.values()].some((item) => !item.window.isDestroyed());
    },
    async load() {
      session = await input.store.load();
      return session;
    },
    async restore(open: (entry: SavedDesktopWindow) => Promise<void>) {
      const windows = [...session.windows];
      for (const entry of windows) pendingRestores.set(entry.id, entry);
      restoring = true;
      try {
        for (const entry of windows) {
          try {
            await open(entry);
          } catch (error) {
            input.onError(error);
          }
        }
      } finally {
        restoring = false;
        persist();
      }
    },
    track(window: SessionWindow, entry: SavedDesktopWindow) {
      pendingRestores.delete(entry.id);
      active.set(entry.id, { window, entry: structuredClone(entry) });
      for (const event of ["move", "resize", "maximize", "unmaximize", "restore"])
        window.on(event, schedule);
      for (const event of ["did-navigate", "did-navigate-in-page"])
        window.webContents.on(event, schedule);
      window.on("close", persist);
      window.on("closed", () => {
        active.delete(entry.id);
        for (const event of ["did-navigate", "did-navigate-in-page"])
          window.webContents.removeListener(event, schedule);
        if (!quitting) persist();
      });
      schedule();
    },
    beginQuit() {
      if (quitting) return;
      persist();
      quitting = true;
    },
  };
}
