import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyAttachmentFileToManagedStorage,
  garbageCollectManagedAttachmentFiles,
  writeAttachmentBase64,
} from "./attachments";

const originalPaseoHome = process.env.PASEO_HOME;
let testHome: string | null = null;

async function useTempPaseoHome(): Promise<string> {
  testHome = await mkdtemp(path.join(os.tmpdir(), "paseo-desktop-attachments-"));
  process.env.PASEO_HOME = testHome;
  return testHome;
}

describe("desktop attachment files", () => {
  it("collects only its window's files while keeping general and other-window attachments", async () => {
    await useTempPaseoHome();
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const general = await writeAttachmentBase64({ attachmentId: "general", base64: "YQ==" });
    const a = await writeAttachmentBase64({ attachmentId: `pw_${first}__a`, base64: "YQ==" });
    const b = await writeAttachmentBase64({ attachmentId: `pw_${second}__b`, base64: "Yg==" });
    expect(
      await garbageCollectManagedAttachmentFiles({ projectWindowId: first, referencedIds: [] }),
    ).toBe(1);
    await expect(readFile(a.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(general.path, "utf8")).resolves.toBe("a");
    await expect(readFile(b.path, "utf8")).resolves.toBe("b");
    expect(await garbageCollectManagedAttachmentFiles({ referencedIds: [] })).toBe(1);
    await expect(readFile(b.path, "utf8")).resolves.toBe("b");
    expect(
      await garbageCollectManagedAttachmentFiles({
        projectWindowId: second,
        referencedIds: [`pw_${second}__b`],
      }),
    ).toBe(0);
    await expect(
      garbageCollectManagedAttachmentFiles({ projectWindowId: "../other" }),
    ).rejects.toThrow("Invalid project window");
  });
  afterEach(async () => {
    if (originalPaseoHome === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = originalPaseoHome;
    }

    if (testHome) {
      await rm(testHome, { recursive: true, force: true });
      testHome = null;
    }
  });

  it("accepts dot-prefixed picker extensions for managed copies", async () => {
    const paseoHome = await useTempPaseoHome();
    const sourcePath = path.join(paseoHome, "report.md");
    await writeFile(sourcePath, "# Report\n");

    const result = await copyAttachmentFileToManagedStorage({
      attachmentId: "att_markdown",
      sourcePath,
      extension: ".md",
    });

    expect(result).toEqual({
      path: path.join(paseoHome, "desktop-attachments", "att_markdown.md"),
      byteSize: 9,
    });
    await expect(readFile(result.path, "utf8")).resolves.toBe("# Report\n");
  });

  it("normalizes legacy bare extensions for managed copies", async () => {
    const paseoHome = await useTempPaseoHome();
    const sourcePath = path.join(paseoHome, "report.md");
    await writeFile(sourcePath, "# Report\n");

    const result = await copyAttachmentFileToManagedStorage({
      attachmentId: "att_markdown_legacy",
      sourcePath,
      extension: "md",
    });

    expect(result).toEqual({
      path: path.join(paseoHome, "desktop-attachments", "att_markdown_legacy.md"),
      byteSize: 9,
    });
    await expect(readFile(result.path, "utf8")).resolves.toBe("# Report\n");
  });
});
