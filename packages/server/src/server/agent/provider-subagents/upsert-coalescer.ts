import type { ProviderSubagentDescriptor } from "./store.js";

export const PROVIDER_SUBAGENT_UPSERT_WINDOW_MS = 100;

export interface ProviderSubagentUpsertCoalescerTimers {
  setTimeout: (callback: () => void, ms?: number) => ReturnType<typeof setTimeout>;
  clearTimeout: typeof clearTimeout;
}

export interface ProviderSubagentUpsertCoalescerOptions {
  windowMs?: number;
  timers: ProviderSubagentUpsertCoalescerTimers;
  onSend: (subagent: ProviderSubagentDescriptor) => void;
}

function subagentKey(parentAgentId: string, subagentId: string): string {
  return `${parentAgentId}\0${subagentId}`;
}

/**
 * Sends at most one descriptor per subagent per window.
 *
 * A descriptor replaces the previous one wholesale on the client, so of everything reported
 * inside a window only the newest has to go out. The first report in a window is sent at once,
 * which keeps a lone status change immediate; the rest wait for the window to close, and the
 * newest of them is always sent.
 */
export class ProviderSubagentUpsertCoalescer {
  private readonly waiting = new Map<string, ProviderSubagentDescriptor>();
  private readonly sentThisWindow = new Set<string>();
  private readonly onSend: (subagent: ProviderSubagentDescriptor) => void;
  private readonly timers: ProviderSubagentUpsertCoalescerTimers;
  private readonly windowMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ProviderSubagentUpsertCoalescerOptions) {
    this.windowMs = options.windowMs ?? PROVIDER_SUBAGENT_UPSERT_WINDOW_MS;
    this.timers = options.timers;
    this.onSend = options.onSend;
  }

  push(subagent: ProviderSubagentDescriptor): void {
    const key = subagentKey(subagent.parentAgentId, subagent.id);
    if (this.sentThisWindow.has(key)) {
      this.waiting.set(key, subagent);
      return;
    }
    this.send(key, subagent);
  }

  /** A removed subagent has no state left to announce. */
  discard(parentAgentId: string, subagentId: string): void {
    this.waiting.delete(subagentKey(parentAgentId, subagentId));
  }

  dispose(): void {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    this.waiting.clear();
    this.sentThisWindow.clear();
  }

  private send(key: string, subagent: ProviderSubagentDescriptor): void {
    this.sentThisWindow.add(key);
    if (!this.timer) {
      this.timer = this.timers.setTimeout(() => this.closeWindow(), this.windowMs);
      this.timer.unref?.();
    }
    this.onSend(subagent);
  }

  private closeWindow(): void {
    this.timer = null;
    const waiting = [...this.waiting];
    this.waiting.clear();
    this.sentThisWindow.clear();
    // Whatever waited opens the next window, so a sustained burst stays at one per window.
    for (const [key, subagent] of waiting) {
      this.send(key, subagent);
    }
  }
}
