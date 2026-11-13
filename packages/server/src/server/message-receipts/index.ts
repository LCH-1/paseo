import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
  agentId: z.string(),
});
const RECEIPT_FILE_NAME = /^[0-9a-f]{64}\.json$/;
interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  send: () => Promise<void>;
  prepare?: () => Promise<void>;
}

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly directory: string) {}

  send(input: SendMessageInput): Promise<void> {
    // Preserve the existing on-disk identity and shape across daemon upgrades.
    const key = digest(["send", input.agentId, input.messageId]);
    const previous = this.pending.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.sendOnce(key, input),
    );
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  /**
   * Removes completed receipts last written before `cutoffMs`. A completed receipt only answers a
   * retry of the same message, and the daemon passes a cutoff 30 days back
   * (COMPLETED_RECEIPT_RETENTION_MS), so a retry is not sent again for at least 30 days after
   * delivery completed. Once the receipt is gone, reusing that message ID sends the message again.
   * A pending receipt stays: it is what stops a message of unknown outcome from being sent twice.
   * The legacy creation receipts kept in this directory share the shape and the rule.
   */
  async expireCompleted(cutoffMs: number): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isMissingFile(error)) return 0;
      throw error;
    }
    let removed = 0;
    for (const name of names) {
      if (!RECEIPT_FILE_NAME.test(name)) continue;
      const key = name.slice(0, -".json".length);
      if (this.pending.has(key)) continue;
      const file = path.join(this.directory, name);
      try {
        if ((await stat(file)).mtimeMs > cutoffMs) continue;
        if ((await readReceipt(file))?.state !== "completed") continue;
      } catch {
        // Unreadable or racing a writer: leave it for the next pass.
        continue;
      }
      if (this.pending.has(key)) continue;
      await rm(file, { force: true });
      removed += 1;
    }
    return removed;
  }

  private async sendOnce(key: string, input: SendMessageInput): Promise<void> {
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = digest(input.request);
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      if (existing.state === "completed") return;
      // A provider may have accepted the message before its receipt was committed.
      throw new Error("agent_request_outcome_unknown");
    }
    await input.prepare?.();
    const receipt = { fingerprint, agentId: input.agentId };
    await writeJsonFileAtomic(file, { ...receipt, state: "pending" });
    await input.send();
    await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
  }
}

async function readReceipt(file: string): Promise<z.infer<typeof ReceiptSchema> | null> {
  try {
    return ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) => {
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          return Object.fromEntries(
            Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return candidate;
      }),
    )
    .digest("hex");
}
