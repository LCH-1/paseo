import { describe, expect, it, vi } from "vitest";
import * as desktop from "@/desktop/host";
import { z } from "zod";
import type { StateStorage } from "zustand/middleware";
import { createValidatedPersistStorage } from "./validated-persist-storage";

class MemoryStorage implements StateStorage {
  readonly values = new Map<string, string>();

  getItem(name: string): string | null {
    return this.values.get(name) ?? null;
  }

  setItem(name: string, value: string): void {
    this.values.set(name, value);
  }

  removeItem(name: string): void {
    this.values.delete(name);
  }
}

const StateSchema = z.strictObject({ enabled: z.boolean() });

describe("createValidatedPersistStorage", () => {
  it("persists independent window drafts without reading or overwriting general-window drafts", async () => {
    const backing = new MemoryStorage();
    const storage = createValidatedPersistStorage(backing, StateSchema);
    const scope = {
      windowId: "one",
      serverId: "host",
      projectId: "project",
      projectName: "Project",
      directory: "/project",
    };
    const host = vi.spyOn(desktop, "getDesktopHost");
    try {
      host.mockReturnValue(null);
      await storage.setItem("paseo-drafts", { state: { enabled: true } });
      host.mockReturnValue({ projectWindow: scope });
      await expect(storage.getItem("paseo-drafts")).resolves.toBeNull();
      await storage.setItem("paseo-drafts", { state: { enabled: false } });
      host.mockReturnValue({ projectWindow: { ...scope, windowId: "two" } });
      await expect(storage.getItem("paseo-drafts")).resolves.toBeNull();
      host.mockReturnValue({ projectWindow: scope });
      await expect(storage.getItem("paseo-drafts")).resolves.toEqual({ state: { enabled: false } });
      await storage.removeItem("paseo-drafts");
      host.mockReturnValue(null);
      await expect(storage.getItem("paseo-drafts")).resolves.toEqual({ state: { enabled: true } });
    } finally {
      host.mockRestore();
    }
  });
  it.each([
    ["malformed JSON", "{"],
    ["invalid state", JSON.stringify({ state: { enabled: "yes" }, version: 1 })],
    ["unknown state fields", JSON.stringify({ state: { enabled: true, extra: true }, version: 1 })],
    [
      "unknown envelope fields",
      JSON.stringify({ state: { enabled: true }, version: 1, extra: true }),
    ],
  ])("clears %s", async (_label, stored) => {
    const backing = new MemoryStorage();
    backing.values.set("settings", stored);
    const storage = createValidatedPersistStorage(backing, StateSchema);

    await expect(storage.getItem("settings")).resolves.toBeNull();
    expect(backing.values.has("settings")).toBe(false);
  });

  it("returns schema-validated state", async () => {
    const backing = new MemoryStorage();
    backing.values.set("settings", JSON.stringify({ state: { enabled: true }, version: 1 }));
    const storage = createValidatedPersistStorage(backing, StateSchema);

    await expect(storage.getItem("settings")).resolves.toEqual({
      state: { enabled: true },
      version: 1,
    });
  });

  it("clears a value rejected by the schema before writing", async () => {
    const backing = new MemoryStorage();
    backing.values.set("settings", JSON.stringify({ state: { count: 1 } }));
    const storage = createValidatedPersistStorage(
      backing,
      z.strictObject({ count: z.number().finite() }),
    );

    await storage.setItem("settings", { state: { count: Number.NaN } });

    expect(backing.values.has("settings")).toBe(false);
  });
});
