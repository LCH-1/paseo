import path from "node:path";
import { existsSync } from "node:fs";
import type { Session } from "electron";

export function configureDesktopDownloads(session: Session, desktop: string): void {
  session.setDownloadPath(desktop);
  const pending = new Set<string>();
  session.on("will-download", (_event, item) => {
    const rawName = path.posix.basename(item.getFilename().replace(/\\/g, "/"));
    const fileName = rawName && rawName !== "." && rawName !== ".." ? rawName : "download";
    const extension = path.extname(fileName);
    const stem = fileName.slice(0, fileName.length - extension.length);
    let destination = path.join(desktop, fileName);
    for (let suffix = 1; existsSync(destination) || pending.has(destination); suffix++) {
      destination = path.join(desktop, `${stem} (${suffix})${extension}`);
    }
    pending.add(destination);
    item.once("done", () => pending.delete(destination));
    item.setSavePath(destination);
  });
}
