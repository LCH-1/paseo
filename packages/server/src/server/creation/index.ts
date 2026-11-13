import type { Logger } from "pino";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  CreationSnapshotSchema,
  type AgentSnapshotPayload,
  type CreationFailure,
  type CreationSnapshot,
  type WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { writeFileAtomic } from "../atomic-file.js";
import { generateWorkspaceId } from "../workspace-registry-model.js";

type Observer = (snapshot: CreationSnapshot) => void;
export interface CreatedAgent {
  agent: AgentSnapshotPayload;
  initialPromptStarted: boolean;
}
interface CreationRequest {
  key: string;
  request: { [key: string]: unknown };
  workspaceId?: string;
  agentId?: string;
  hasAgent: boolean;
  hasPrompt: boolean;
  /** Kept only with a failed receipt, so the message can be restored after the client is gone. */
  prompt?: string;
  exists: (kind: "workspace" | "agent", id: string) => Promise<boolean>;
  provision?: (
    workspaceId: string,
  ) => Promise<{ workspace: WorkspaceDescriptorPayload; setupSkippedReason?: string }>;
  createAgent?: (
    agentId: string,
    workspace: WorkspaceDescriptorPayload | undefined,
    onReady: (agent: AgentSnapshotPayload) => Promise<void>,
  ) => Promise<CreatedAgent>;
}
export type CreationInput = CreationRequest &
  (
    | { kind: "workspace" }
    | { kind: "agent"; readAgent: (id: string) => Promise<AgentSnapshotPayload | null> }
  );
const RecordSchema = z.object({
  fingerprint: z.string(),
  snapshot: CreationSnapshotSchema,
  inFlight: z.enum(["workspace", "agent", "prompt"]).nullable(),
  failedPrompt: z.string().optional(),
});
type Record = z.infer<typeof RecordSchema>;
const RECEIPT_FILE_NAME = /^[0-9a-f]{64}\.json$/;

/** Owns creation across socket lifetimes. Resource owners perform work; this module commits its milestones. */
export class CreationService {
  private admission: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<string, Promise<CreationSnapshot>>();
  private readonly receiptOperations = new Map<string, Promise<void>>();
  private readonly observers = new Map<string, Set<Observer>>();
  constructor(
    private readonly directory: string,
    private readonly logger: Logger,
    private readonly validateCompleted: (
      snapshot: CreationSnapshot,
    ) => Promise<void> = async () => {},
    private readonly legacyDirectory?: string,
    private readonly onTerminal?: (snapshot: CreationSnapshot) => Promise<void>,
  ) {}

  async create(input: CreationInput, observer?: Observer): Promise<CreationSnapshot> {
    const identity = identityFor(input.kind, input.key);
    const admitted = this.admission.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const fingerprint = digest(input.request);
      let record = await this.read(identity);
      if (!record) record = await this.readLegacyAgent(input, fingerprint);
      if (record && record.fingerprint !== fingerprint)
        throw new Error(`${input.kind}_request_key_conflict`);
      const running = this.active.get(identity);
      if (running && record) return { completion: running, snapshot: record.snapshot };
      if (record?.snapshot.phase === "completed") await this.validateCompleted(record.snapshot);
      if (record?.snapshot.phase === "completed" || record?.snapshot.outcomeUnknown) {
        return { completion: Promise.resolve(record.snapshot), snapshot: record.snapshot };
      }
      if (record?.inFlight) {
        await this.publish(identity, record, {
          phase: "failed",
          error: `${input.kind}_request_outcome_unknown`,
          failedStage: record.inFlight,
          outcomeUnknown: true,
        });
        return { completion: Promise.resolve(record.snapshot), snapshot: record.snapshot };
      }
      if (!record) {
        record = initialRecord(input, fingerprint);
        // Persist identity before claiming resources. A failed admission can only retry these IDs.
        await this.write(identity, record);
      }
      await this.claimResources(identity, record.snapshot, input);
      if (record.snapshot.phase === "failed") {
        await this.publish(identity, record, {
          phase: record.snapshot.workspace ? "workspace_ready" : "accepted",
          error: null,
          errorCode: undefined,
          failedStage: undefined,
          outcomeUnknown: undefined,
        });
      }
      const snapshot = record.snapshot;
      // Defer the runner until admission has installed the initiating observer.
      const completion = Promise.resolve().then(() => this.run(identity, record, input));
      this.active.set(identity, completion);
      void completion.finally(() => this.active.delete(identity)).catch(() => undefined);
      return { completion, snapshot };
    });
    this.admission = admitted.then(
      () => undefined,
      () => undefined,
    );
    // Install before admission starts, so even a fast local provision cannot outrun observation.
    const unsubscribe = observer ? this.observe(identity, observer) : () => {};
    try {
      const { completion, snapshot } = await admitted;
      if (observer) this.notify(observer, snapshot);
      return await completion;
    } finally {
      unsubscribe();
    }
  }

  async subscribe(
    kind: CreationSnapshot["kind"],
    key: string,
    observer: Observer,
  ): Promise<{ snapshot: CreationSnapshot | null; unsubscribe: () => void }> {
    const identity = identityFor(kind, key);
    const unsubscribe = this.observe(identity, observer);
    try {
      await this.admission;
      const record = await this.read(identity);
      if (record?.inFlight && !this.active.has(identity)) {
        await this.publish(identity, record, {
          phase: "failed",
          failedStage: record.inFlight,
          outcomeUnknown: true,
          error: `${kind}_request_outcome_unknown`,
        });
      }
      if (record?.snapshot.phase === "completed") await this.validateCompleted(record.snapshot);
      return { snapshot: record?.snapshot ?? null, unsubscribe };
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  /** The newest failure for a workspace. A workspace that outlives its failed agent has no other trace of it. */
  async findFailedForWorkspace(workspaceId: string): Promise<CreationFailure | null> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    let latest: { modifiedAt: number; failure: CreationFailure } | null = null;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await this.readForLookup(name.slice(0, -".json".length));
      if (record?.snapshot.phase !== "failed" || record.snapshot.workspaceId !== workspaceId)
        continue;
      const { mtimeMs: modifiedAt } = await stat(join(this.directory, name));
      if (latest && latest.modifiedAt >= modifiedAt) continue;
      latest = {
        modifiedAt,
        failure: {
          error: record.snapshot.error ?? `${record.snapshot.kind}_request_failed`,
          outcomeUnknown: record.snapshot.outcomeUnknown,
          prompt: record.failedPrompt,
        },
      };
    }
    return latest?.failure ?? null;
  }

  /**
   * Removes completed creation receipts last written before `cutoffMs`, with the resource claims
   * they own. The daemon passes a cutoff 30 days back (COMPLETED_RECEIPT_RETENTION_MS), so a retry
   * of the same creation key gets the resources it made for at least 30 days after completion.
   * Afterwards the key is a new request: one that left its IDs to the daemon creates another
   * workspace or agent and sends its first prompt again, and one that named them gets
   * *_id_conflict while they exist. Failed receipts stay: they are a workspace's only trace of a
   * failed agent and its restorable prompt. A receipt that is still in flight or being created is
   * never touched.
   */
  async expireCompleted(cutoffMs: number): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
      throw error;
    }
    // Claims hold their owner's identity; a claim left behind would let a replay of that key skip
    // the existence check for the resource it names.
    const claimsByOwner = new Map<string, string[]>();
    for (const name of names) {
      if (!name.endsWith(".claim")) continue;
      const owner = await readOptional(join(this.directory, name)).catch(() => null);
      if (owner === null) continue;
      claimsByOwner.set(owner, [...(claimsByOwner.get(owner) ?? []), name]);
    }
    let removed = 0;
    for (const name of names) {
      if (!RECEIPT_FILE_NAME.test(name)) continue;
      const identity = name.slice(0, -".json".length);
      if (this.active.has(identity)) continue;
      const expired = await this.accessReceipt(identity, async () => {
        if (!(await this.removeIfExpired(identity, cutoffMs))) return false;
        for (const claim of claimsByOwner.get(identity) ?? []) {
          const file = join(this.directory, claim);
          if ((await readOptional(file)) === identity) await rm(file, { force: true });
        }
        return true;
      }).catch((err: unknown) => {
        this.logger.warn({ err, identity }, "Skipped expiring creation receipt");
        return false;
      });
      if (expired) removed += 1;
    }
    return removed;
  }

  private async removeIfExpired(identity: string, cutoffMs: number): Promise<boolean> {
    if (this.active.has(identity)) return false;
    const file = join(this.directory, `${identity}.json`);
    const modifiedAt = await stat(file).then(
      (stats) => stats.mtimeMs,
      () => null,
    );
    if (modifiedAt === null || modifiedAt > cutoffMs) return false;
    const text = await readOptional(file);
    const parsed = text === null ? null : RecordSchema.safeParse(JSON.parse(text));
    if (!parsed?.success) return false;
    if (parsed.data.snapshot.phase !== "completed" || parsed.data.inFlight !== null) return false;
    await rm(file, { force: true });
    return true;
  }

  private async readForLookup(identity: string): Promise<Record | null> {
    try {
      return await this.read(identity);
    } catch (err) {
      // One unreadable receipt must not hide the failure this lookup exists to report.
      this.logger.warn({ err, identity }, "Skipped unreadable creation receipt");
      return null;
    }
  }

  private async run(
    identity: string,
    record: Record,
    input: CreationInput,
  ): Promise<CreationSnapshot> {
    delete record.failedPrompt;
    try {
      if (input.provision && !record.snapshot.workspace) {
        record.inFlight = "workspace";
        await this.write(identity, record);
        const { workspace, setupSkippedReason } = await input.provision(
          record.snapshot.workspaceId!,
        );
        record.inFlight = null;
        await this.publish(identity, record, {
          phase: "workspace_ready",
          workspace,
          workspaceId: workspace.id,
          setupSkippedReason,
        });
      }
      if (input.hasAgent && input.createAgent && !record.snapshot.agent) {
        record.inFlight = "agent";
        await this.write(identity, record);
        const { agent, initialPromptStarted } = await input.createAgent(
          record.snapshot.agentId!,
          record.snapshot.workspace,
          async (readyAgent) => {
            record.inFlight = input.hasPrompt ? "prompt" : null;
            await this.publish(identity, record, {
              phase: "agent_ready",
              agent: readyAgent,
              workspaceId: readyAgent.workspaceId ?? record.snapshot.workspaceId,
            });
          },
        );
        record.inFlight = null;
        if (initialPromptStarted)
          await this.publish(identity, record, { phase: "prompt_started", agent });
        else record.snapshot = { ...record.snapshot, agent };
      }
      record.inFlight = null;
      await this.publish(identity, record, { phase: "completed" });
    } catch (error) {
      const stage = record.inFlight ?? "agent";
      const resourceId =
        stage === "workspace" ? record.snapshot.workspaceId : record.snapshot.agentId;
      const code =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined;
      const rejectedBeforeProvision = code === "directory_not_found" || code === "source_required";
      const unknown =
        stage === "prompt" ||
        (stage === "workspace" && !rejectedBeforeProvision) ||
        (resourceId !== null && (await input.exists(stage, resourceId)));
      // A failed provider startup with no registered resource can retry under the same ID.
      // A partially provisioned resource or an attempted prompt needs reconciliation.
      if (!unknown) record.inFlight = null;
      record.failedPrompt = restorablePrompt(input.prompt);
      await this.publish(identity, record, {
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
        errorCode: code,
        failedStage: stage,
        outcomeUnknown: unknown,
      });
    }
    return record.snapshot;
  }

  // COMPAT(agentRequestReceipts): added in v0.8.0, remove after 2027-03-11 once old creation receipts can expire.
  // Import the previous receipt format; it is never a second execution path.
  private async readLegacyAgent(input: CreationInput, fingerprint: string): Promise<Record | null> {
    if (input.kind !== "agent" || !this.legacyDirectory) return null;
    const text = await readOptional(
      join(this.legacyDirectory, `${digest(["create", input.key])}.json`),
    );
    if (text === null) return null;
    const receipt = z
      .object({
        fingerprint: z.string(),
        state: z.enum(["pending", "completed"]),
        agentId: z.string(),
      })
      .parse(JSON.parse(text));
    if (receipt.fingerprint !== digest({ type: "create_agent_request", ...input.request }))
      throw new Error("agent_request_key_conflict");
    const agent = await input.readAgent(receipt.agentId);
    if (!agent && receipt.state === "completed")
      throw new Error("Previously created agent no longer exists");
    const record = initialRecord({ ...input, agentId: receipt.agentId }, fingerprint);
    record.snapshot = {
      ...record.snapshot,
      phase: agent ? "completed" : "failed",
      agent: agent ?? undefined,
      workspaceId: agent?.workspaceId ?? record.snapshot.workspaceId,
      error: agent ? null : "agent_request_outcome_unknown",
      ...(agent ? {} : { failedStage: "agent", outcomeUnknown: true }),
    };
    await this.write(identityFor(input.kind, input.key), record);
    return record;
  }

  private async claimResources(
    identity: string,
    snapshot: CreationSnapshot,
    input: CreationInput,
  ): Promise<void> {
    if (input.kind === "workspace" && snapshot.workspaceId)
      await this.claim(identity, "workspace", snapshot.workspaceId, input.exists);
    if (snapshot.agentId) await this.claim(identity, "agent", snapshot.agentId, input.exists);
  }

  private async claim(
    identity: string,
    kind: "workspace" | "agent",
    id: string,
    exists: CreationInput["exists"],
  ): Promise<void> {
    const file = join(this.directory, `${digest([kind, id])}.claim`);
    const owner = await readOptional(file);
    if (owner !== null) {
      if (owner !== identity) throw new Error(`${kind}_id_conflict`);
      return;
    }
    if (await exists(kind, id)) throw new Error(`${kind}_id_conflict`);
    await writeFile(file, identity, { flag: "wx", mode: 0o600 });
  }
  private observe(identity: string, observer: Observer): () => void {
    const observers = this.observers.get(identity) ?? new Set<Observer>();
    observers.add(observer);
    this.observers.set(identity, observers);
    return () => {
      observers.delete(observer);
      if (!observers.size) this.observers.delete(identity);
    };
  }
  private notify(observer: Observer, snapshot: CreationSnapshot): void {
    try {
      observer(snapshot);
    } catch (err) {
      this.logger.warn(
        {
          err,
          kind: snapshot.kind,
          idempotencyKey: snapshot.idempotencyKey,
          phase: snapshot.phase,
        },
        "Creation observer failed",
      );
    }
  }
  private async publish(
    identity: string,
    record: Record,
    update: Partial<CreationSnapshot>,
  ): Promise<void> {
    record.snapshot = { ...record.snapshot, ...update, revision: record.snapshot.revision + 1 };
    await this.write(identity, record);
    for (const observer of this.observers.get(identity) ?? [])
      this.notify(observer, record.snapshot);
    if (record.snapshot.phase === "completed" || record.snapshot.phase === "failed") {
      try {
        await this.onTerminal?.(record.snapshot);
      } catch (err) {
        // Refreshing subscribers cannot undo a durable result or retry resource creation.
        this.logger.warn(
          { err, kind: record.snapshot.kind, phase: record.snapshot.phase },
          "Creation terminal observer failed",
        );
      }
    }
  }
  private write(identity: string, record: Record): Promise<void> {
    // Serialize now: the runner mutates the record after queueing this write.
    const contents = JSON.stringify(record, null, 2);
    return this.accessReceipt(identity, () =>
      writeFileAtomic(join(this.directory, `${identity}.json`), contents),
    );
  }
  private read(identity: string): Promise<Record | null> {
    return this.accessReceipt(identity, async () => {
      const text = await readOptional(join(this.directory, `${identity}.json`));
      return text === null ? null : RecordSchema.parse(JSON.parse(text));
    });
  }
  private accessReceipt<T>(identity: string, access: () => Promise<T>): Promise<T> {
    // Admission and the runner progress independently. Keep this owner from
    // holding a receipt read open while atomically replacing the same file.
    const previous = this.receiptOperations.get(identity) ?? Promise.resolve();
    const result = previous.then(access);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.receiptOperations.set(identity, settled);
    void settled.finally(() => {
      if (this.receiptOperations.get(identity) === settled) this.receiptOperations.delete(identity);
    });
    return result;
  }
}
function restorablePrompt(prompt: string | undefined): string | undefined {
  return prompt?.trim() ? prompt : undefined;
}
function initialRecord(input: CreationInput, fingerprint: string): Record {
  return {
    fingerprint,
    inFlight: null,
    snapshot: {
      kind: input.kind,
      idempotencyKey: input.key,
      revision: 0,
      phase: "accepted",
      error: null,
      workspaceId: input.workspaceId ?? (input.kind === "workspace" ? generateWorkspaceId() : null),
      agentId: input.hasAgent ? (input.agentId ?? randomUUID()) : null,
    },
  };
}
function identityFor(kind: string, key: string): string {
  return digest([kind, key]);
}
function digest(input: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(input, (_key, value: unknown) => {
        if (value && typeof value === "object" && !Array.isArray(value))
          return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
        return value;
      }),
    )
    .digest("hex");
}
async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
