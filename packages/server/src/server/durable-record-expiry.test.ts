import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { CreationService, type CreationInput } from "./creation/index.js";
import {
  COMPLETED_RECEIPT_RETENTION_MS,
  startDurableRecordExpiry,
  sweepDurableRecords,
  UPLOAD_RETENTION_MS,
} from "./durable-record-expiry.js";
import { MessageReceipts } from "./message-receipts/index.js";

const DAY_MS = 24 * 60 * 60_000;
const NOW = Date.parse("2026-11-13T00:00:00.000Z");
const silentLogger = pino({ level: "silent" });
const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "durable-expiry-"));
  directories.push(home);
  return home;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function age(path: string, ageMs: number): Promise<void> {
  const at = new Date(NOW - ageMs);
  await utimes(path, at, at);
}

const workspace: WorkspaceDescriptorPayload = {
  id: "wks_0123456789abcdef",
  projectId: "project",
  projectDisplayName: "Project",
  projectRootPath: "/project",
  workspaceDirectory: "/project/worktree",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "Worktree",
  status: "running",
  statusEnteredAt: null,
  activityAt: null,
  archivingAt: null,
  scripts: [],
};

function workspaceCreation(key: string, provision: CreationInput["provision"]): CreationInput {
  return {
    kind: "workspace",
    key,
    request: { key },
    hasAgent: false,
    hasPrompt: false,
    exists: async () => false,
    provision,
  };
}

test("completed message receipts expire after the retention; pending and recent ones stay", async () => {
  const home = await createHome();
  const directory = join(home, "agent-requests");
  const receipts = new MessageReceipts(directory);
  let deliveries = 0;
  const send = (messageId: string) =>
    receipts.send({
      agentId: "agent",
      messageId,
      request: { text: messageId },
      send: async () => {
        deliveries += 1;
      },
    });
  await send("old");
  await send("recent");
  const pendingKey = digest(["send", "agent", "lost"]);
  await writeFile(
    join(directory, `${pendingKey}.json`),
    JSON.stringify({ fingerprint: "f", state: "pending", agentId: "agent" }),
  );
  const [oldName, recentName] = ["old", "recent"].map(
    (messageId) => `${digest(["send", "agent", messageId])}.json`,
  );
  await age(join(directory, oldName!), COMPLETED_RECEIPT_RETENTION_MS + DAY_MS);
  await age(join(directory, recentName!), COMPLETED_RECEIPT_RETENTION_MS - DAY_MS);
  await age(join(directory, `${pendingKey}.json`), 365 * DAY_MS);
  await writeFile(join(directory, "notes.json"), "{}");
  await age(join(directory, "notes.json"), 365 * DAY_MS);

  expect(await receipts.expireCompleted(NOW - COMPLETED_RECEIPT_RETENTION_MS)).toBe(1);

  expect((await readdir(directory)).sort()).toEqual(
    [recentName, `${pendingKey}.json`, "notes.json"].sort(),
  );
  // The recent receipt still answers its retry without a second delivery.
  await send("recent");
  expect(deliveries).toBe(2);
});

test("completed creation receipts expire with their claims; recent and failed ones stay", async () => {
  const home = await createHome();
  const directory = join(home, "creations");
  const creations = new CreationService(directory, silentLogger);
  let provisions = 0;
  const provision: CreationInput["provision"] = async (id) => {
    provisions += 1;
    return { workspace: { ...workspace, id } };
  };
  const completed = await creations.create(workspaceCreation("done", provision));
  expect(completed.phase).toBe("completed");
  const failed = await creations.create(
    workspaceCreation("broken", async () => {
      throw Object.assign(new Error("missing"), { code: "directory_not_found" });
    }),
  );
  expect(failed.phase).toBe("failed");
  const doneIdentity = digest(["workspace", "done"]);
  const brokenIdentity = digest(["workspace", "broken"]);
  for (const name of await readdir(directory)) {
    await age(join(directory, name), COMPLETED_RECEIPT_RETENTION_MS + DAY_MS);
  }
  const doneClaim = `${digest(["workspace", completed.workspaceId])}.claim`;
  expect(await readdir(directory)).toContain(doneClaim);
  // A completed receipt inside the retention still answers a reconnecting client's retry.
  const recent = await creations.create(workspaceCreation("recent", provision));
  expect(recent.phase).toBe("completed");
  const recentReceipt = `${digest(["workspace", "recent"])}.json`;
  const recentClaim = `${digest(["workspace", recent.workspaceId])}.claim`;
  for (const name of [recentReceipt, recentClaim]) {
    await age(join(directory, name), COMPLETED_RECEIPT_RETENTION_MS - DAY_MS);
  }
  // Another creation's claim is not this receipt's to release.
  await writeFile(join(directory, `${digest(["agent", "someone-else"])}.claim`), brokenIdentity);

  expect(await creations.expireCompleted(NOW - COMPLETED_RECEIPT_RETENTION_MS)).toBe(1);

  const remaining = await readdir(directory);
  expect(remaining).not.toContain(`${doneIdentity}.json`);
  expect(remaining).not.toContain(doneClaim);
  expect(remaining).toContain(recentReceipt);
  expect(remaining).toContain(recentClaim);
  expect(remaining).toContain(`${brokenIdentity}.json`);
  expect(remaining).toContain(`${digest(["workspace", failed.workspaceId])}.claim`);
  expect(remaining).toContain(`${digest(["agent", "someone-else"])}.claim`);
  // The retry gets the same workspace back instead of provisioning another one.
  expect(await creations.create(workspaceCreation("recent", provision))).toEqual(recent);
  expect(provisions).toBe(2);
});

test("a creation still running is not expired", async () => {
  const home = await createHome();
  const directory = join(home, "creations");
  const creations = new CreationService(directory, silentLogger);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const running = creations.create(
    workspaceCreation("running", async () => {
      await held;
      return { workspace };
    }),
  );
  const identityFile = `${digest(["workspace", "running"])}.json`;
  await vi.waitFor(async () => expect(await readdir(directory)).toContain(identityFile));
  await age(join(directory, identityFile), COMPLETED_RECEIPT_RETENTION_MS + DAY_MS);

  expect(await creations.expireCompleted(NOW)).toBe(0);
  release();
  expect((await running).phase).toBe("completed");
  expect(await readdir(directory)).toContain(identityFile);
});

test("uploads expire by their newest write after the upload retention", async () => {
  const home = await createHome();
  const uploads = join(home, "uploads");
  const make = async (id: string, fileAgeMs: number) => {
    const directory = join(uploads, `upload_${id}`);
    await mkdir(directory, { recursive: true });
    const file = join(directory, "notes.txt");
    await writeFile(file, "hello");
    await age(file, fileAgeMs);
    await age(directory, UPLOAD_RETENTION_MS + 10 * DAY_MS);
    return directory;
  };
  const old = await make("00000000-0000-4000-8000-000000000001", UPLOAD_RETENTION_MS + DAY_MS);
  const recent = await make("00000000-0000-4000-8000-000000000002", UPLOAD_RETENTION_MS - DAY_MS);
  const foreign = join(uploads, "keep-me");
  await mkdir(foreign);
  await age(foreign, 365 * DAY_MS);

  const removed = await sweepDurableRecords({
    messageReceipts: new MessageReceipts(join(home, "agent-requests")),
    creations: new CreationService(join(home, "creations"), silentLogger),
    paseoHome: home,
    logger: silentLogger,
    now: () => NOW,
  });

  expect(removed).toEqual({ messageReceipts: 0, creations: 0, uploads: 1 });
  expect(existsSync(old)).toBe(false);
  expect(existsSync(recent)).toBe(true);
  expect(existsSync(foreign)).toBe(true);
});

test("the sweep expires creation receipts after thirty days and keeps younger ones", async () => {
  const home = await createHome();
  const directory = join(home, "creations");
  const creations = new CreationService(directory, silentLogger);
  let provisions = 0;
  const provision: CreationInput["provision"] = async (id) => {
    provisions += 1;
    return { workspace: { ...workspace, id } };
  };
  const old = await creations.create(workspaceCreation("old", provision));
  const young = await creations.create(workspaceCreation("young", provision));
  const files = (key: string, workspaceId: string | null) => [
    `${digest(["workspace", key])}.json`,
    `${digest(["workspace", workspaceId])}.claim`,
  ];
  for (const name of files("old", old.workspaceId)) {
    await age(join(directory, name), 31 * DAY_MS);
  }
  for (const name of files("young", young.workspaceId)) {
    await age(join(directory, name), 29 * DAY_MS);
  }

  const removed = await sweepDurableRecords({
    messageReceipts: new MessageReceipts(join(home, "agent-requests")),
    creations,
    paseoHome: home,
    logger: silentLogger,
    now: () => NOW,
  });

  expect(removed).toEqual({ messageReceipts: 0, creations: 1, uploads: 0 });
  expect((await readdir(directory)).sort()).toEqual(files("young", young.workspaceId).sort());
  // A reconnecting client's retry gets the same workspace back instead of provisioning another.
  expect(await creations.create(workspaceCreation("young", provision))).toEqual(young);
  expect(provisions).toBe(2);
});

test("the sweep runs shortly after start, then daily, and stops with the daemon", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const home = await createHome();
  const cutoffs: [string, number][] = [];
  const store = (name: string) => ({
    expireCompleted: async (cutoffMs: number) => {
      cutoffs.push([name, cutoffMs]);
      return 0;
    },
  });
  const stop = startDurableRecordExpiry({
    messageReceipts: store("messageReceipts"),
    creations: store("creations"),
    paseoHome: home,
    logger: silentLogger,
    now: () => NOW,
  });
  // Both receipt stores keep a completed receipt for thirty days.
  const sweep = [
    ["messageReceipts", NOW - 30 * DAY_MS],
    ["creations", NOW - 30 * DAY_MS],
  ];

  await vi.advanceTimersByTimeAsync(59_000);
  expect(cutoffs).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(cutoffs).toEqual(sweep));
  await vi.advanceTimersByTimeAsync(DAY_MS);
  await vi.waitFor(() => expect(cutoffs).toEqual([...sweep, ...sweep]));

  stop();
  await vi.advanceTimersByTimeAsync(2 * DAY_MS);
  expect(cutoffs).toHaveLength(4);
});
