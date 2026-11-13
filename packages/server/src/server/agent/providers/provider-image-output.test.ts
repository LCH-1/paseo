import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import MarkdownIt from "markdown-it";
import { projectTimelineRows } from "../timeline-projection.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  isProviderImageMarkdown,
  materializeProviderImage,
  providerImageDirectory,
  PROVIDER_IMAGE_RETENTION_MS,
  pruneProviderImages,
  removeProcessProviderImageDirectories,
  renderProviderImageOutputAsAssistantMarkdown,
  configureProviderImageDirectory,
} from "./provider-image-output.js";

const HASH = "a".repeat(64);

function renderImageMarkdown(imagePath: string): string {
  const item = renderProviderImageOutputAsAssistantMarkdown({ path: imagePath });
  if (!item || item.type !== "assistant_message") {
    throw new Error("Expected provider image output to render as assistant markdown.");
  }
  return item.text;
}

describe("isProviderImageMarkdown", () => {
  test("matches the markdown emitted for a materialized attachment", () => {
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments/${HASH}.png)`)).toBe(true);
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments-a1B2c3/${HASH}.png)`)).toBe(
      true,
    );
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments/user-1000/${HASH}.png)`)).toBe(
      true,
    );
    expect(isProviderImageMarkdown(`![shot](/var/folders/x/paseo-attachments/${HASH}.webp)`)).toBe(
      true,
    );
    // Windows: backslash path separators are doubled by escapeMarkdownImageSource.
    expect(
      isProviderImageMarkdown(
        `![Image](C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Temp\\\\paseo-attachments\\\\${HASH}.png)`,
      ),
    ).toBe(true);
  });

  test("emits Windows file paths as file URIs", () => {
    const markdown = renderImageMarkdown(
      `C:\\Users\\me\\AppData\\Local\\Temp\\paseo-attachments\\${HASH}.png`,
    );

    expect(markdown).toBe(
      `\n\n![Image](file:///C:/Users/me/AppData/Local/Temp/paseo-attachments/${HASH}.png)\n\n`,
    );
    expect(isProviderImageMarkdown(markdown)).toBe(true);
  });

  test("emits POSIX file paths with spaces as valid file URI markdown", () => {
    const markdown = renderImageMarkdown("/home/user/Projects/Project With Spaces/screenshot.png");

    expect(markdown).toBe(
      "\n\n![Image](file:///home/user/Projects/Project%20With%20Spaces/screenshot.png)\n\n",
    );
  });

  test("encodes URI-significant characters in POSIX file paths", () => {
    const markdown = renderImageMarkdown("/tmp/screenshot#1?draft.png");

    expect(markdown).toBe("\n\n![Image](file:///tmp/screenshot%231%3Fdraft.png)\n\n");
  });

  test("preserves double-leading slashes in POSIX file paths", () => {
    const markdown = renderImageMarkdown("//tmp/screenshot#1.png");

    expect(markdown).toBe("\n\n![Image](file:////tmp/screenshot%231.png)\n\n");
  });

  test.each([
    ["UNC", "\\\\server\\share\\shot#1.png", "file://server/share/shot%231.png"],
    [
      "extended UNC",
      "\\\\?\\UNC\\server\\share\\shot?draft.png",
      "file://server/share/shot%3Fdraft.png",
    ],
  ])("encodes %s image paths as file URIs", (_label, imagePath, expectedSource) => {
    expect(renderImageMarkdown(imagePath)).toBe(`\n\n![Image](${expectedSource})\n\n`);
  });

  test.each([
    ["Windows", `D:\\Paseo Data (main)\\.paseo\\runtime\\provider-images\\${HASH}.png`],
    ["POSIX", `/home/me/Paseo (main)/.paseo/runtime/provider-images/${HASH}.png`],
  ])("matches an image under a %s Paseo home with parentheses", (_label, imagePath) => {
    const markdown = renderImageMarkdown(imagePath);

    expect(markdown).toContain("(main\\)");
    expect(isProviderImageMarkdown(markdown)).toBe(true);
  });

  test("matches an image whose alt text carries an escaped bracket", () => {
    const item = renderProviderImageOutputAsAssistantMarkdown({
      path: `/tmp/paseo-attachments/${HASH}.png`,
      altText: "chart [v2]",
    });

    expect(item?.type === "assistant_message" && isProviderImageMarkdown(item.text)).toBe(true);
  });

  test("matches alt text that ends in a lone backslash, as the plain alt text did", () => {
    expect(isProviderImageMarkdown(`![a\\](/tmp/paseo-attachments/${HASH}.png)`)).toBe(true);
    expect(isProviderImageMarkdown(`![a\\\\\\](/tmp/paseo-attachments/${HASH}.png)`)).toBe(true);
  });

  test("answers at once for text whose alt text holds a long run of backslashes", () => {
    // Replay checks every text block of a tool result row, and a regular expression cannot be
    // sliced: a match that took seconds held every agent, terminal and request on the daemon.
    const rejected = [
      `![${"\\a".repeat(56)}](https://example.com/a.png)`,
      `![${"C:\\Users\\me\\proj".repeat(12)}](./shot.png)`,
    ];
    const accepted = renderProviderImageOutputAsAssistantMarkdown({
      path: `/tmp/paseo-attachments/${HASH}.png`,
      altText: "C:\\Users\\me\\proj ".repeat(40),
    });

    const startedAt = performance.now();
    expect(rejected.map((text) => isProviderImageMarkdown(text))).toEqual([false, false]);
    expect(accepted?.type === "assistant_message" && isProviderImageMarkdown(accepted.text)).toBe(
      true,
    );
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  test("answers at once for text that closes and reopens its alt text many times", () => {
    // Every "\](" was a place the alt text could end, and each one rescanned the rest of the
    // text for a source: 30KB of them held the daemon for a quarter of a second.
    const rejected = [`![${"\\](".repeat(10_000)}x`, `![${"a\\](b".repeat(10_000)}`];
    const accepted = renderProviderImageOutputAsAssistantMarkdown({
      path: `/tmp/paseo-attachments/${HASH}.png`,
      altText: "](".repeat(10_000),
    });

    const startedAt = performance.now();
    expect(rejected.map((text) => isProviderImageMarkdown(text))).toEqual([false, false]);
    expect(accepted?.type === "assistant_message" && isProviderImageMarkdown(accepted.text)).toBe(
      true,
    );
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  test("rejects user-authored markdown that is not a materialized attachment", () => {
    // No content hash — a hand-written path, not something the writer produced.
    expect(isProviderImageMarkdown("![diagram](./paseo-attachments/notes.png)")).toBe(false);
    expect(isProviderImageMarkdown("![logo](https://example.com/logo.png)")).toBe(false);
    // Image markdown that does not start the text.
    expect(isProviderImageMarkdown("see the chart: ![chart](x.png)")).toBe(false);
  });
});

describe("materializeProviderImage", () => {
  test("recreates the private temp directory if the cached directory is removed", () => {
    const first = materializeProviderImage({
      data: "YWJjMTIz",
      mimeType: "image/png",
    });
    const firstDir = path.dirname(first.path);
    expect(existsSync(first.path)).toBe(true);

    rmSync(firstDir, { recursive: true, force: true });

    const second = materializeProviderImage({
      data: "ZGVmNDU2",
      mimeType: "image/png",
    });
    const secondDir = path.dirname(second.path);

    try {
      expect(existsSync(second.path)).toBe(true);
    } finally {
      rmSync(secondDir, { recursive: true, force: true });
    }
  });
});

describe("daemon provider image directory", () => {
  let paseoHome: string;
  let release: (() => void) | null = null;

  beforeEach(() => {
    paseoHome = mkdtempSync(path.join(os.tmpdir(), "provider-image-home-"));
  });

  afterEach(() => {
    release?.();
    release = null;
    vi.resetModules();
    removeProcessProviderImageDirectories();
    rmSync(paseoHome, { recursive: true, force: true });
  });

  test("keeps images in one folder under the Paseo home across daemon restarts", async () => {
    const directory = providerImageDirectory(paseoHome);
    release = configureProviderImageDirectory(directory);
    const first = materializeProviderImage({ data: "YWJjMTIz", mimeType: "image/png" });

    // A restarted daemon is a fresh module instance with no memory of the previous folder.
    vi.resetModules();
    const restarted = await import("./provider-image-output.js");
    const releaseRestarted = restarted.configureProviderImageDirectory(directory);
    try {
      const second = restarted.materializeProviderImage({
        data: "YWJjMTIz",
        mimeType: "image/png",
      });

      expect(path.dirname(first.path)).toBe(directory);
      expect(second.path).toBe(first.path);
      expect(readdirSync(directory)).toEqual([path.basename(first.path)]);
    } finally {
      releaseRestarted();
    }
  });

  test("renders images from the daemon folder as provider image markdown", () => {
    release = configureProviderImageDirectory(providerImageDirectory(paseoHome));
    const item = renderProviderImageOutputAsAssistantMarkdown(
      { data: "YWJjMTIz", mimeType: "image/png" },
      { materialize: materializeProviderImage },
    );

    expect(item?.type === "assistant_message" && isProviderImageMarkdown(item.text.trim())).toBe(
      true,
    );
    expect(
      isProviderImageMarkdown(`![Image](/home/me/.paseo/runtime/provider-images/${HASH}.png)`),
    ).toBe(true);
    expect(
      isProviderImageMarkdown(
        `![Image](file:///C:/Users/me/.paseo/runtime/provider-images/${HASH}.png)`,
      ),
    ).toBe(true);
  });

  test("stops writing to a home it was released from", () => {
    const directory = providerImageDirectory(paseoHome);
    configureProviderImageDirectory(directory)();

    const materialized = materializeProviderImage({ data: "YWJjMTIz", mimeType: "image/png" });

    expect(path.dirname(materialized.path)).not.toBe(directory);
    expect(existsSync(directory)).toBe(false);
  });

  test("gives a running daemon its folder back when a daemon started after it stops", () => {
    const first = providerImageDirectory(path.join(paseoHome, "first"));
    const second = providerImageDirectory(path.join(paseoHome, "second"));
    release = configureProviderImageDirectory(first);
    const releaseSecond = configureProviderImageDirectory(second);
    const written = () =>
      path.dirname(materializeProviderImage({ data: "YWJjMTIz", mimeType: "image/png" }).path);

    try {
      expect(written()).toBe(second);
    } finally {
      releaseSecond();
    }
    expect(written()).toBe(first);
  });

  test("keeps the second daemon's folder when the first one stops", () => {
    const first = providerImageDirectory(path.join(paseoHome, "first"));
    const second = providerImageDirectory(path.join(paseoHome, "second"));
    const releaseFirst = configureProviderImageDirectory(first);
    release = configureProviderImageDirectory(second);

    releaseFirst();

    expect(
      path.dirname(materializeProviderImage({ data: "YWJjMTIz", mimeType: "image/png" }).path),
    ).toBe(second);
  });

  test("removes a process's own temp folder when the process exits", () => {
    const materialized = materializeProviderImage({ data: "YWJjMTIz", mimeType: "image/png" });
    const tempDirectory = path.dirname(materialized.path);
    expect(path.basename(tempDirectory)).toMatch(new RegExp(`^paseo-attachments-${process.pid}-`));
    expect(process.listeners("exit")).toContain(removeProcessProviderImageDirectories);

    removeProcessProviderImageDirectories();

    expect(existsSync(tempDirectory)).toBe(false);
  });

  test("prunes images not written within the retention window", async () => {
    const directory = providerImageDirectory(paseoHome);
    mkdirSync(directory, { recursive: true });
    const now = Date.parse("2026-11-13T12:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    const stale = path.join(directory, `${"b".repeat(64)}.png`);
    const fresh = path.join(directory, `${"c".repeat(64)}.webp`);
    const foreign = path.join(directory, "notes.txt");
    for (const file of [stale, fresh, foreign]) writeFileSync(file, "image");
    utimesSync(stale, new Date(now - 91 * day), new Date(now - 91 * day));
    utimesSync(fresh, new Date(now - 89 * day), new Date(now - 89 * day));
    utimesSync(foreign, new Date(now - 400 * day), new Date(now - 400 * day));

    const result = await pruneProviderImages({
      directory,
      maxAgeMs: PROVIDER_IMAGE_RETENTION_MS,
      now,
    });

    expect(result).toEqual({ removedFiles: 1, removedBytes: 5, keptFiles: 1 });
    expect(readdirSync(directory).sort()).toEqual(
      [path.basename(fresh), path.basename(foreign)].sort(),
    );
  });

  test("prunes every stale image of a folder larger than one batch", async () => {
    const directory = providerImageDirectory(paseoHome);
    mkdirSync(directory, { recursive: true });
    const now = Date.parse("2026-11-13T12:00:00.000Z");
    const stale = new Date(now - 91 * 24 * 60 * 60 * 1000);
    const names = Array.from(
      { length: 50 },
      (_, index) => `${index.toString(16).padStart(64, "0")}.png`,
    );
    for (const [index, name] of names.entries()) {
      writeFileSync(path.join(directory, name), "image");
      if (index % 2 === 0) utimesSync(path.join(directory, name), stale, stale);
    }

    const result = await pruneProviderImages({
      directory,
      maxAgeMs: PROVIDER_IMAGE_RETENTION_MS,
      now,
    });

    expect(result).toEqual({ removedFiles: 25, removedBytes: 125, keptFiles: 25 });
    expect(readdirSync(directory).sort()).toEqual(names.filter((_, index) => index % 2 === 1));
  });

  test("prunes nothing when the folder does not exist yet", async () => {
    await expect(
      pruneProviderImages({
        directory: providerImageDirectory(paseoHome),
        maxAgeMs: PROVIDER_IMAGE_RETENTION_MS,
      }),
    ).resolves.toEqual({ removedFiles: 0, removedBytes: 0, keptFiles: 0 });
  });
});

describe("provider image paragraph boundaries", () => {
  test.each(["", "\n"])("keeps image outputs separate from prose ending in %j", (ending) => {
    const image = renderProviderImageOutputAsAssistantMarkdown({
      url: "https://example.com/chart.png",
    });
    if (!image) throw new Error("Expected image output");
    const projected = projectTimelineRows({
      mode: "projected",
      rows: [
        {
          seq: 1,
          timestamp: "2026-10-16T15:08:23Z",
          item: { type: "assistant_message", text: `Before${ending}`, messageId: "commentary" },
        },
        { seq: 2, timestamp: "2026-10-16T15:08:24Z", item: image },
        {
          seq: 3,
          timestamp: "2026-10-16T15:08:25Z",
          item: { type: "assistant_message", text: "After" },
        },
      ],
    });
    expect(projected).toHaveLength(1);
    const item = projected[0]!.item;
    if (item.type !== "assistant_message") throw new Error("Expected assistant message");
    const paragraphs = new MarkdownIt()
      .parse(item.text, {})
      .filter((token) => token.type === "inline");
    expect(paragraphs.map((token) => token.content)).toEqual([
      "Before",
      "![Image](https://example.com/chart.png)",
      "After",
    ]);
  });
});

test("materialized image output retains paragraph boundaries and attachment recognition", () => {
  const item = renderProviderImageOutputAsAssistantMarkdown(
    { data: "YWJjMTIz", mimeType: "image/png" },
    { materialize: () => ({ path: `/tmp/paseo-attachments/${HASH}.png` }) },
  );
  expect(item).toEqual({
    type: "assistant_message",
    text: `\n\n![Image](file:///tmp/paseo-attachments/${HASH}.png)\n\n`,
  });
  if (!item || item.type !== "assistant_message") throw new Error("Expected image output");
  expect(isProviderImageMarkdown(item.text)).toBe(true);
});
