import type * as FsPromises from "node:fs/promises";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { MessageReceipts } from "./index.js";

// Runs once, right after the next file read completes and before its reader resumes.
const readHook = vi.hoisted(() => ({ next: null as (() => void) | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const content = await actual.readFile(...args);
    const hook = readHook.next;
    readHook.next = null;
    hook?.();
    return content;
  }) as typeof actual.readFile;
  return { ...actual, readFile };
});

const DAY_MS = 24 * 60 * 60_000;
const directories: string[] = [];
afterEach(async () => {
  readHook.next = null;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("a completed receipt is kept when its message is retried while the sweep reads it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-requests-"));
  directories.push(directory);
  const receipts = new MessageReceipts(directory);
  let deliveries = 0;
  const send = () =>
    receipts.send({
      agentId: "agent",
      messageId: "old",
      request: { text: "old" },
      send: async () => {
        deliveries += 1;
      },
    });
  await send();
  const [name] = await readdir(directory);
  const writtenAt = new Date(Date.now() - 60 * DAY_MS);
  await utimes(path.join(directory, name!), writtenAt, writtenAt);

  // The retry arrives after the sweep found the receipt completed and old, before it removes it.
  let retry: Promise<void> | undefined;
  readHook.next = () => {
    retry = send();
  };
  expect(await receipts.expireCompleted(Date.now() - 30 * DAY_MS)).toBe(0);
  await retry;

  expect(retry).toBeDefined();
  expect(deliveries).toBe(1);
  expect(await readdir(directory)).toEqual([name]);
});
