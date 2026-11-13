import type { Logger } from "pino";
import { expireUploads } from "./file-upload/index.js";

const DAY_MS = 24 * 60 * 60_000;
// The whole replay guarantee for a creation key or message ID: a retry of the same request gets the
// completed result for at least 30 days after completion, counted on the wall clock from the
// receipt's last write, so days the daemon was off count. A daily sweep then removes the receipt,
// and the key or message ID becomes a new request: a creation that left its IDs to the daemon makes
// another workspace or agent and sends its first prompt again, one that named them gets
// *_id_conflict while they exist, and a message is sent again. Only completed receipts expire;
// failed and unsettled ones stay. Hub persists its keys and message IDs and owns its reconnect
// recovery, so this bound is all a Hub retry can rely on. The app keeps creation keys in memory,
// so a restart never reuses one, but while it runs it resubmits an unsettled creation on every
// reconnect, however late. Thirty days is far past any realistic retry from either and stops the
// directories growing.
export const COMPLETED_RECEIPT_RETENTION_MS = 30 * DAY_MS;
// An upload is referenced by path from the prompt that carried it and from any draft still
// holding it, so it lives as long as conversation history is kept rather than as long as a receipt.
export const UPLOAD_RETENTION_MS = 90 * DAY_MS;
// Let startup Git and session restore settle before touching the disk.
const FIRST_SWEEP_DELAY_MS = 60_000;
const SWEEP_INTERVAL_MS = DAY_MS;

interface ExpiringReceipts {
  expireCompleted(cutoffMs: number): Promise<number>;
}

export interface DurableRecordExpiryOptions {
  messageReceipts: ExpiringReceipts;
  creations: ExpiringReceipts;
  paseoHome: string;
  logger: Logger;
  now?: () => number;
}

/** Sweeps once shortly after the daemon starts and then once a day. Returns a stop function. */
export function startDurableRecordExpiry(options: DurableRecordExpiryOptions): () => void {
  let running = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  const sweep = () => {
    if (running) return;
    running = true;
    void sweepDurableRecords(options).finally(() => {
      running = false;
    });
  };
  const first = setTimeout(() => {
    sweep();
    interval = setInterval(sweep, SWEEP_INTERVAL_MS);
    interval.unref?.();
  }, FIRST_SWEEP_DELAY_MS);
  first.unref?.();
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
    interval = null;
  };
}

export async function sweepDurableRecords(options: DurableRecordExpiryOptions): Promise<{
  messageReceipts: number;
  creations: number;
  uploads: number;
}> {
  const now = (options.now ?? Date.now)();
  const startedAt = performance.now();
  const receiptCutoff = now - COMPLETED_RECEIPT_RETENTION_MS;
  const expire = async (store: string, run: () => Promise<number>): Promise<number> => {
    try {
      return await run();
    } catch (err) {
      options.logger.warn({ err, store }, "Durable record expiry failed");
      return 0;
    }
  };
  const removed = {
    messageReceipts: await expire("agent-requests", () =>
      options.messageReceipts.expireCompleted(receiptCutoff),
    ),
    creations: await expire("creations", () => options.creations.expireCompleted(receiptCutoff)),
    uploads: await expire("uploads", () =>
      expireUploads(options.paseoHome, now - UPLOAD_RETENTION_MS),
    ),
  };
  if (removed.messageReceipts + removed.creations + removed.uploads > 0) {
    options.logger.info(
      { removed, durationMs: Math.round(performance.now() - startedAt) },
      "Expired completed receipts and uploads",
    );
  }
  return removed;
}
