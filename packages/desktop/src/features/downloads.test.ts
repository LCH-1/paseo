import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Session } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureDesktopDownloads } from "./downloads.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const desktop = mkdtempSync(path.join(tmpdir(), "paseo-desktop-download-"));
  directories.push(desktop);
  const session = Object.assign(new EventEmitter(), { setDownloadPath: vi.fn() });
  configureDesktopDownloads(session as unknown as Session, desktop);
  const download = (name: string) => {
    const item = Object.assign(new EventEmitter(), { getFilename: () => name, setSavePath: vi.fn() });
    session.emit("will-download", {}, item);
    return item;
  };
  return { desktop, session, download };
}

describe("configureDesktopDownloads", () => {
  it("saves to the supplied current-user desktop without a save dialog", () => {
    const { desktop, session, download } = setup();
    expect(session.setDownloadPath).toHaveBeenCalledWith(desktop);
    expect(download("배포 자료.zip").setSavePath).toHaveBeenCalledWith(path.join(desktop, "배포 자료.zip"));
  });

  it("preserves existing files and reserves names for simultaneous downloads", () => {
    const { desktop, download } = setup();
    writeFileSync(path.join(desktop, "report.zip"), "existing");
    const first = download("report.zip");
    expect(first.setSavePath).toHaveBeenCalledWith(path.join(desktop, "report (1).zip"));
    expect(download("report.zip").setSavePath).toHaveBeenCalledWith(path.join(desktop, "report (2).zip"));
    first.emit("done", {}, "cancelled");
    expect(download("report.zip").setSavePath).toHaveBeenCalledWith(path.join(desktop, "report (1).zip"));
  });

  it.each(["../../report.zip", "..\\..\\report.zip"])("keeps %s inside the desktop", (name) => {
    const { desktop, download } = setup();
    expect(download(name).setSavePath).toHaveBeenCalledWith(path.join(desktop, "report.zip"));
  });
});
