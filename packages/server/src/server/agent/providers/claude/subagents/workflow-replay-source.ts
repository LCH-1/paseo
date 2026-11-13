import { z } from "zod";

import type { AgentTimelineItem } from "../../../agent-sdk-types.js";
import { normalizeProviderReplayTimestamp } from "../../../provider-history-timestamps.js";
import type { ProviderSubagentStatus } from "../../../provider-subagents/store.js";
import type { SubagentObservation } from "./observation.js";
import { buildClaudeSubagentSubtitle } from "./presentation.js";
import { runReplaySteps, type ClaudeReplayEntry, type ClaudeReplaySteps } from "./replay-source.js";
import { formatClaudeWorkflowResult } from "./workflow-output.js";

const ClaudeWorkflowRunSchema = z.object({
  runId: z.string(),
  timestamp: z.string().optional().catch(undefined),
  summary: z.string().optional().catch(undefined),
  workflowName: z.string().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
  startTime: z.number().optional().catch(undefined),
  defaultModel: z.string().optional().catch(undefined),
  totalTokens: z.number().optional().catch(undefined),
  result: z.unknown().optional(),
});

export type ClaudeWorkflowRun = z.infer<typeof ClaudeWorkflowRunSchema>;

export interface ClaudeWorkflowParentEntry {
  message?: { content?: unknown };
}

export function parseClaudeWorkflowRun(contents: string): ClaudeWorkflowRun | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  const result = ClaudeWorkflowRunSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Rebuild workflow rows from Claude's persisted run summaries.
 *
 * The parent tool result links a Workflow tool-use id to a run id. The run summary owns the
 * terminal outcome and presentation facts. A nonterminal summary cannot still be live after the
 * provider runtime was recreated, so replay terminalizes it as failed instead of resurrecting a
 * row that can never receive another update.
 */
interface ClaudeReplayWorkflowsInput {
  workflows: readonly ClaudeWorkflowRun[];
  parentEntries: readonly ClaudeWorkflowParentEntry[];
  entriesByRunId?: ReadonlyMap<string, readonly ClaudeReplayEntry[]>;
  convertEntry?: (entry: ClaudeReplayEntry) => AgentTimelineItem[];
}

export function observeReplayWorkflows(input: ClaudeReplayWorkflowsInput): SubagentObservation[] {
  return runReplaySteps(observeReplayWorkflowsSteps(input));
}

export function* observeReplayWorkflowsSteps(
  input: ClaudeReplayWorkflowsInput,
): ClaudeReplaySteps<SubagentObservation[]> {
  const toolCallIdByRunId = readWorkflowLinks(input.parentEntries);
  const observations: SubagentObservation[] = [];

  for (const workflow of input.workflows) {
    const id = toolCallIdByRunId.get(workflow.runId);
    if (!id) continue;
    const description = readString(workflow.summary) ?? readString(workflow.workflowName);
    const startedAt = normalizeEpochTimestamp(workflow.startTime);
    const finishedAt = normalizeIsoTimestamp(workflow.timestamp);

    observations.push({
      kind: "declared",
      id,
      toolCallId: id,
      title: "Workflow",
      ...(description ? { description } : {}),
      ...(startedAt ? { timestamp: startedAt } : {}),
    });
    if (description) {
      observations.push({
        kind: "timeline",
        id,
        item: { type: "user_message", text: description },
        ...(startedAt ? { timestamp: startedAt } : {}),
      });
    }

    const timeline = yield* observeWorkflowTimelineSteps({
      id,
      result: workflow.result,
      entries: input.entriesByRunId?.get(workflow.runId) ?? [],
      convertEntry: input.convertEntry,
      finishedAt,
    });
    for (const observation of timeline) observations.push(observation);

    const subtitle = buildClaudeSubagentSubtitle({
      title: "Workflow",
      ...(readString(workflow.defaultModel) ? { model: workflow.defaultModel } : {}),
      ...(typeof workflow.totalTokens === "number"
        ? { usage: { totalTokens: workflow.totalTokens } }
        : {}),
    });
    if (subtitle) {
      observations.push({
        kind: "subtitle",
        id,
        subtitle,
        ...(finishedAt ? { timestamp: finishedAt } : {}),
      });
    }
    observations.push({
      kind: "status",
      id,
      status: replayWorkflowStatus(workflow.status),
      ...(finishedAt ? { timestamp: finishedAt } : {}),
    });
  }

  return observations;
}

function* observeWorkflowTimelineSteps(input: {
  id: string;
  result: unknown;
  entries: readonly ClaudeReplayEntry[];
  convertEntry?: (entry: ClaudeReplayEntry) => AgentTimelineItem[];
  finishedAt?: string;
}): ClaudeReplaySteps<SubagentObservation[]> {
  const observations: SubagentObservation[] = [];
  const replayedAssistantText = new Set<string>();
  const order = yield* orderByReplayTimeSteps(input.entries);

  for (const index of order) {
    const entry = input.entries[index];
    const timestamp = normalizeProviderReplayTimestamp(entry.timestamp);
    const items = input.convertEntry?.(entry) ?? [];
    for (const item of items) {
      if (item.type === "assistant_message") replayedAssistantText.add(item.text.trim());
      observations.push({
        kind: "timeline",
        id: input.id,
        item,
        ...(timestamp ? { timestamp } : {}),
      });
    }
    yield;
  }

  const resultText = formatClaudeWorkflowResult(input.result);
  if (!resultText || replayedAssistantText.has(resultText.trim())) return observations;
  observations.push({
    kind: "timeline",
    id: input.id,
    item: { type: "assistant_message", text: resultText },
    ...(input.finishedAt ? { timestamp: input.finishedAt } : {}),
  });
  return observations;
}

/** Ordering work done between pauses: entries timed, or entries moved by a merge. */
const ORDER_STEP_ENTRIES = 1024;

/**
 * Indexes of `entries` in time order. Entries without a time go last, and entries with the same
 * time keep their order. Sorting the 320,000 entries of a large workflow in one call, parsing two
 * times per comparison, held the daemon for half a second. This parses each time once and merges
 * in pieces with a pause between them. A workflow's entries are its files one after another, each
 * already in time order, so there are about as many runs to merge as files.
 */
function* orderByReplayTimeSteps(
  entries: readonly ClaudeReplayEntry[],
): ClaudeReplaySteps<Uint32Array> {
  const count = entries.length;
  const times = new Float64Array(count);
  let order = new Uint32Array(count);
  // Where each run of entries already in time order starts, then where the last one ends.
  let runBounds = [0];
  for (let index = 0; index < count; index += 1) {
    times[index] = readReplayTime(entries[index].timestamp);
    order[index] = index;
    if (index > 0 && times[index] < times[index - 1]) runBounds.push(index);
    if (index % ORDER_STEP_ENTRIES === ORDER_STEP_ENTRIES - 1) yield;
  }
  runBounds.push(count);

  let merged = new Uint32Array(count);
  let budget = ORDER_STEP_ENTRIES;
  while (runBounds.length > 2) {
    const mergedBounds = [0];
    for (let run = 0; run + 1 < runBounds.length; run += 2) {
      const start = runBounds[run];
      const middle = runBounds[run + 1];
      // An odd run out has nothing to merge with and is copied as it is.
      const end = run + 2 < runBounds.length ? runBounds[run + 2] : middle;
      let left = start;
      let right = middle;
      for (let next = start; next < end; next += 1) {
        // On equal times the earlier run goes first, which keeps those entries in order.
        if (right >= end || (left < middle && times[order[left]] <= times[order[right]])) {
          merged[next] = order[left++];
        } else {
          merged[next] = order[right++];
        }
        budget -= 1;
        if (budget === 0) {
          budget = ORDER_STEP_ENTRIES;
          yield;
        }
      }
      mergedBounds.push(end);
    }
    [order, merged] = [merged, order];
    runBounds = mergedBounds;
  }
  return order;
}

function readReplayTime(value: unknown): number {
  const timestamp = normalizeProviderReplayTimestamp(value);
  return timestamp ? Date.parse(timestamp) : Number.POSITIVE_INFINITY;
}

function readWorkflowLinks(entries: readonly ClaudeWorkflowParentEntry[]): Map<string, string> {
  const workflowToolCallIds = new Set<string>();
  const toolCallIdByRunId = new Map<string, string>();

  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const value of content) {
      const block = toRecord(value);
      if (block?.type !== "tool_use" || block.name !== "Workflow") continue;
      const id = readString(block.id);
      if (id) workflowToolCallIds.add(id);
    }
  }

  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const value of content) {
      const block = toRecord(value);
      if (block?.type !== "tool_result") continue;
      const toolCallId = readString(block.tool_use_id);
      if (!toolCallId || !workflowToolCallIds.has(toolCallId)) continue;
      const runId = readRunId(block.content);
      if (runId) toolCallIdByRunId.set(runId, toolCallId);
    }
  }

  return toolCallIdByRunId;
}

function readRunId(content: unknown): string | undefined {
  const text = readResultText(content);
  if (!text) return undefined;
  return /(?:^|\n)Run ID:\s*(wf_[A-Za-z0-9-]+)/u.exec(text)?.[1];
}

function readResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const text = content
    .map((value) => {
      const block = toRecord(value);
      return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
    })
    .filter((value): value is string => value !== undefined)
    .join("\n");
  return text || undefined;
}

function replayWorkflowStatus(status: string | undefined): ProviderSubagentStatus {
  switch (status?.trim().toLowerCase()) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "canceled":
    case "cancelled":
    case "killed":
    case "stopped":
      return "canceled";
    default:
      return "failed";
  }
}

function normalizeEpochTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeIsoTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
