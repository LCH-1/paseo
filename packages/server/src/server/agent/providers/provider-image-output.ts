import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ensurePrivateDirectory as ensurePrivatePaseoHomeDirectory,
  ensurePrivateFile as ensurePrivatePaseoHomeFile,
} from "../../private-files.js";
import type { AgentTimelineItem } from "../agent-sdk-types.js";

export interface ProviderImageOutput {
  path?: string | null;
  url?: string | null;
  data?: string | null;
  mimeType?: string | null;
  altText?: string | null;
}

export interface MaterializedProviderImage {
  path: string;
}

const PROVIDER_IMAGE_ATTACHMENT_DIR = "paseo-attachments";
const PROVIDER_IMAGE_ATTACHMENT_DIR_PREFIX = `${PROVIDER_IMAGE_ATTACHMENT_DIR}-`;
const PROVIDER_IMAGE_DIR = "provider-images";
const PRIVATE_ATTACHMENT_DIR_MODE = 0o700;
const MATERIALIZED_IMAGE_FILE_MODE = 0o600;
const MATERIALIZED_IMAGE_FILE_NAME = /^[0-9a-f]{64}\.[a-z0-9]+$/;

/**
 * How long an image is kept after it was last written. Replay rewrites every image it renders,
 * so an image a timeline still shows stays fresh. The rest are referenced only by path from
 * provider-owned history (a Codex image attachment, the path Pi and OMP pass to a text-only
 * model) and nothing rewrites them: they go this long after the prompt that attached them, the
 * same horizon Claude and Codex conversation history is kept for.
 */
export const PROVIDER_IMAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Ages are read this many at a time: one by one, 3,000 images held daemon startup ~0.3s. */
const PRUNE_CONCURRENCY = 16;

/** Where the daemon keeps provider images: one folder per Paseo home, reused across restarts. */
export function providerImageDirectory(paseoHome: string): string {
  return path.join(paseoHome, "runtime", PROVIDER_IMAGE_DIR);
}

// Set by the daemon. Anything else that imports a provider (a test, a script) writes to a temp
// folder of its own instead of a Paseo home it was never told about. The latest registration
// wins; when an in-process daemon stops, one still running gets its folder back.
const configuredImageDirectories: Array<{ directory: string }> = [];
let processImageDirectory: string | null = null;
const processImageDirectories = new Set<string>();
let removesProcessImageDirectoriesOnExit = false;

/**
 * Makes the daemon write provider images to `directory`. Each daemon process used to leave a new
 * temp folder behind. Returns a function that stops using it, for in-process daemons that stop
 * and delete their home while the process lives on.
 */
export function configureProviderImageDirectory(directory: string): () => void {
  const registration = { directory };
  configuredImageDirectories.push(registration);
  return () => {
    const index = configuredImageDirectories.indexOf(registration);
    if (index >= 0) configuredImageDirectories.splice(index, 1);
  };
}

function ensurePrivateDirectory(dir: string): boolean {
  try {
    const stats = fsSync.lstatSync(dir);
    if (!stats.isDirectory()) {
      return false;
    }
    fsSync.chmodSync(dir, PRIVATE_ATTACHMENT_DIR_MODE);
    return true;
  } catch {
    return false;
  }
}

/** Removes this process's temp image folders. Runs when the process exits. */
export function removeProcessProviderImageDirectories(): void {
  for (const dir of processImageDirectories) {
    try {
      fsSync.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: the process is exiting.
    }
  }
  processImageDirectories.clear();
  processImageDirectory = null;
}

interface ImageAttachmentDirectory {
  path: string;
  /** Under a Paseo home, where permissions are tightened only as far as the filesystem allows. */
  inPaseoHome: boolean;
}

function getMaterializedImageAttachmentDir(): ImageAttachmentDirectory {
  const configured = configuredImageDirectories[configuredImageDirectories.length - 1];
  if (configured) {
    // Like every other private folder in the Paseo home: a home on a filesystem that rejects
    // chmod still gets its images.
    ensurePrivatePaseoHomeDirectory(configured.directory);
    return { path: configured.directory, inPaseoHome: true };
  }

  if (processImageDirectory && ensurePrivateDirectory(processImageDirectory)) {
    return { path: processImageDirectory, inPaseoHome: false };
  }

  // The pid tells a cleanup tool whether the owner is still running. A killed process (test
  // runners kill their workers) cannot remove its folder.
  processImageDirectory = fsSync.mkdtempSync(
    path.join(os.tmpdir(), `${PROVIDER_IMAGE_ATTACHMENT_DIR_PREFIX}${process.pid}-`),
  );
  fsSync.chmodSync(processImageDirectory, PRIVATE_ATTACHMENT_DIR_MODE);
  if (!removesProcessImageDirectoriesOnExit) {
    process.once("exit", removeProcessProviderImageDirectories);
    removesProcessImageDirectoriesOnExit = true;
  }
  processImageDirectories.add(processImageDirectory);
  return { path: processImageDirectory, inPaseoHome: false };
}

export interface ProviderImagePruneResult {
  removedFiles: number;
  removedBytes: number;
  keptFiles: number;
}

/**
 * Deletes images in `directory` that were last written more than `maxAgeMs` ago. Only files named
 * the way materializeProviderImage names them are considered. Run before anything replays, so a
 * replay cannot rewrite an image between its age check and its removal.
 */
export async function pruneProviderImages(input: {
  directory: string;
  maxAgeMs: number;
  now?: number;
}): Promise<ProviderImagePruneResult> {
  const result: ProviderImagePruneResult = { removedFiles: 0, removedBytes: 0, keptFiles: 0 };
  let entries: fsSync.Dirent[];
  try {
    entries = await fsPromises.readdir(input.directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return result;
    throw error;
  }
  const cutoff = (input.now ?? Date.now()) - input.maxAgeMs;
  const images = entries.filter(
    (entry) => entry.isFile() && MATERIALIZED_IMAGE_FILE_NAME.test(entry.name),
  );
  let next = 0;
  const failures: unknown[] = [];
  const pruneNext = async (): Promise<void> => {
    // Stops at the first failure, and the caller waits for every worker: nothing is removed
    // after this function returns and replay starts rewriting images.
    while (failures.length === 0 && next < images.length) {
      const filePath = path.join(input.directory, images[next++]!.name);
      try {
        const stats = await fsPromises.stat(filePath);
        if (stats.mtimeMs >= cutoff) {
          result.keptFiles += 1;
          continue;
        }
        await fsPromises.unlink(filePath);
        result.removedFiles += 1;
        result.removedBytes += stats.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") failures.push(error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PRUNE_CONCURRENCY, images.length) }, () => pruneNext()),
  );
  if (failures.length > 0) throw failures[0];
  return result;
}

function getImageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    default:
      return "bin";
  }
}

function normalizeImageData(mimeType: string, data: string): { mimeType: string; data: string } {
  if (data.startsWith("data:")) {
    const match = data.match(/^data:([^;]+);base64,(.*)$/);
    if (match) {
      return { mimeType: match[1], data: match[2] };
    }
  }
  return { mimeType, data };
}

// Filenames are a content hash of the bytes so re-materializing the same image, within a process
// or after a daemon restart, reuses the existing file instead of leaking a fresh one for repeated
// image blocks or history replay. Rewriting it also refreshes the age pruneProviderImages reads.
export function materializeProviderImage(image: {
  data: string;
  mimeType: string | null;
}): MaterializedProviderImage {
  const attachmentsDir = getMaterializedImageAttachmentDir();
  const normalized = normalizeImageData(image.mimeType ?? "image/png", image.data);
  const bytes = Buffer.from(normalized.data, "base64");
  const extension = getImageExtension(normalized.mimeType);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const filePath = path.join(attachmentsDir.path, `${hash}.${extension}`);
  fsSync.writeFileSync(filePath, bytes, { mode: MATERIALIZED_IMAGE_FILE_MODE });
  if (attachmentsDir.inPaseoHome) ensurePrivatePaseoHomeFile(filePath);
  else fsSync.chmodSync(filePath, MATERIALIZED_IMAGE_FILE_MODE);
  return { path: filePath };
}

// Recognizes markdown rendered for a materialized provider image: its source is a content-hashed
// file in the daemon's image folder, or in the temp folder older releases and non-daemon processes
// use. Matching the full <hash>.<ext> shape (not just a leading "![") keeps user-authored text
// from being mistaken for a provider image during history replay. The separator still accepts old
// doubled-backslash Windows history; new Windows output uses file URIs. Alt text and source may
// carry backslash escapes: a Paseo home such as "D:\Paseo Data (main)" puts "\)" in the source.
// In the alt text a backslash always starts an escape, except a lone one right before the closing
// bracket, which the plain alt text older readers matched may end in. Letting a backslash be read
// either way made a failed match try every split of a run of them, so about 50 backslashes held
// the daemon for seconds. In the source only "\)" reads two ways, and the shorter way fails at once.
const PROVIDER_IMAGE_MARKDOWN = new RegExp(
  `^!\\[(?:\\\\[\\s\\S]|[^\\]\\\\])*\\\\?\\]\\((?:\\\\\\)|[^)])*(?:${PROVIDER_IMAGE_ATTACHMENT_DIR}(?:-[^/\\\\)]+)?|${PROVIDER_IMAGE_DIR})[/\\\\]+(?:[^/\\\\)]+[/\\\\]+)?[0-9a-f]{64}\\.[a-z0-9]+\\)`,
);

export function isProviderImageMarkdown(text: string): boolean {
  return PROVIDER_IMAGE_MARKDOWN.test(text.trimStart());
}

interface RenderProviderImageOutputOptions {
  materialize?: (image: { data: string; mimeType: string | null }) => MaterializedProviderImage;
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isDataImageSource(source: string): boolean {
  return source.trim().toLowerCase().startsWith("data:image/");
}

function escapeMarkdownImageAlt(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function encodeFilePath(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function windowsFileUri(value: string): string | null {
  const isWindowsNetworkPath = value.startsWith("\\\\");
  let normalizedPath = value.replace(/\\/g, "/");
  if (/^\/\/\?\/UNC\//i.test(normalizedPath)) {
    normalizedPath = `//${normalizedPath.slice(8)}`;
  } else if (/^\/\/\?\/[A-Za-z]:\//.test(normalizedPath)) {
    normalizedPath = normalizedPath.slice(4);
  }

  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    const drive = normalizedPath.slice(0, 2);
    return `file:///${drive}${encodeFilePath(normalizedPath.slice(2))}`;
  }
  if (isWindowsNetworkPath && normalizedPath.startsWith("//")) {
    return `file:${encodeFilePath(normalizedPath)}`;
  }
  return null;
}

function markdownImageSource(value: string): string {
  const windowsUri = windowsFileUri(value);
  if (windowsUri) {
    return windowsUri;
  }
  if (value.startsWith("/")) {
    return `file://${encodeFilePath(value)}`;
  }
  return value;
}

function escapeMarkdownImageSource(value: string): string {
  return markdownImageSource(value).replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

export function renderProviderImageOutputAsAssistantMarkdown(
  image: ProviderImageOutput,
  options: RenderProviderImageOutputOptions = {},
): AgentTimelineItem | null {
  const source = nonEmptyString(image.path) ?? nonEmptyString(image.url);
  if (source && !isDataImageSource(source)) {
    const altText = escapeMarkdownImageAlt(nonEmptyString(image.altText) ?? "Image");
    return {
      type: "assistant_message",
      // Image outputs remain standalone paragraphs when adjacent assistant chunks merge.
      text: `\n\n![${altText}](${escapeMarkdownImageSource(source)})\n\n`,
    };
  }

  const data = nonEmptyString(image.data) ?? (source && isDataImageSource(source) ? source : null);
  if (!data) {
    return null;
  }

  let materialized: MaterializedProviderImage | null = null;
  try {
    materialized = options.materialize
      ? options.materialize({
          data,
          mimeType: nonEmptyString(image.mimeType),
        })
      : null;
  } catch {
    materialized = null;
  }
  if (!materialized?.path || isDataImageSource(materialized.path)) {
    return {
      type: "assistant_message",
      text: "Image output was omitted because it was not available as a file path or URL.",
    };
  }

  const altText = escapeMarkdownImageAlt(nonEmptyString(image.altText) ?? "Image");
  return {
    type: "assistant_message",
    text: `\n\n![${altText}](${escapeMarkdownImageSource(materialized.path)})\n\n`,
  };
}
