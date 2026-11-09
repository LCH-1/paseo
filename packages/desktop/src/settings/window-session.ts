import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseProjectWindowTarget, type ProjectWindowScope } from "../window/project-window.js";
import { coerceWindowState, type WindowState } from "./window-state.js";

export interface SavedDesktopWindow {
  id: string;
  projectWindow: ProjectWindowScope | null;
  route: string;
  state: WindowState;
}

export interface DesktopWindowSession {
  version: 1;
  restoreAtLogin: boolean;
  windows: SavedDesktopWindow[];
}

export interface WindowSessionStore {
  load(): Promise<DesktopWindowSession>;
  saveSync(session: DesktopWindowSession): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWindowSessionRoute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    value.length <= 32768 &&
    !/[\\\r\n]/.test(value) &&
    !value.includes(String.fromCharCode(0))
  );
}

function readWindow(value: unknown): SavedDesktopWindow | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^[\w-]{1,128}$/.test(value.id) ||
    !isWindowSessionRoute(value.route)
  )
    return null;
  const state = coerceWindowState(value.state);
  if (!state) return null;
  let projectWindow: ProjectWindowScope | null = null;
  if (value.projectWindow !== null) {
    if (!isRecord(value.projectWindow) || value.projectWindow.windowId !== value.id) return null;
    try {
      projectWindow = { ...parseProjectWindowTarget(value.projectWindow), windowId: value.id };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Invalid project window")) return null;
      throw error;
    }
  }
  return { id: value.id, projectWindow, route: value.route, state };
}

export function createWindowSessionStore(userDataPath: string): WindowSessionStore {
  const filePath = path.join(userDataPath, "window-session.json");
  return {
    async load() {
      const empty: DesktopWindowSession = { version: 1, restoreAtLogin: false, windows: [] };
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return empty;
        throw error;
      }
      let document: unknown;
      try {
        document = JSON.parse(raw);
      } catch (error) {
        if (error instanceof SyntaxError) return empty;
        throw error;
      }
      if (!isRecord(document) || document.version !== 1 || !Array.isArray(document.windows))
        return empty;
      const ids = new Set<string>();
      const windows: SavedDesktopWindow[] = [];
      for (const value of document.windows) {
        const window = readWindow(value);
        if (window && !ids.has(window.id)) {
          windows.push(window);
          ids.add(window.id);
        }
      }
      return { version: 1, restoreAtLogin: document.restoreAtLogin === true, windows };
    },
    saveSync(session) {
      mkdirSync(userDataPath, { recursive: true });
      const temporary = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
      writeFileSync(temporary, JSON.stringify(session), "utf8");
      renameSync(temporary, filePath);
    },
  };
}
