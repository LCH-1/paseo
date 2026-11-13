import type * as Fs from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  configureProviderImageDirectory,
  materializeProviderImage,
  providerImageDirectory,
} from "./provider-image-output.js";

// Some filesystems a Paseo home can live on (network shares, FUSE and Windows mounts on Linux)
// reject chmod outright.
const rejectChmodUnder = vi.hoisted(() => ({ root: null as string | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    chmodSync: (target: Fs.PathLike, mode: Fs.Mode) => {
      if (rejectChmodUnder.root && String(target).startsWith(rejectChmodUnder.root)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${target}'`), {
          code: "EPERM",
        });
      }
      actual.chmodSync(target, mode);
    },
  };
});

describe("provider images in a Paseo home whose filesystem rejects chmod", () => {
  let paseoHome: string;
  let release: () => void;

  beforeEach(() => {
    paseoHome = mkdtempSync(path.join(os.tmpdir(), "provider-image-chmod-"));
    rejectChmodUnder.root = paseoHome;
    release = configureProviderImageDirectory(providerImageDirectory(paseoHome));
  });

  afterEach(() => {
    release();
    rejectChmodUnder.root = null;
    rmSync(paseoHome, { recursive: true, force: true });
  });

  test("still writes the image", () => {
    const materialized = materializeProviderImage({ data: "YWJjMTIz", mimeType: "image/png" });

    expect(path.dirname(materialized.path)).toBe(providerImageDirectory(paseoHome));
    expect(existsSync(materialized.path)).toBe(true);
  });
});
