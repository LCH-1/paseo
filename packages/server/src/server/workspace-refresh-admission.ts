import { AsyncLocalStorage } from "node:async_hooks";

// Named like the p-limit rejection it replaces, which callers already treat as a shutdown signal.
class WorkspaceRefreshAdmissionClearedError extends Error {
  constructor() {
    super("Workspace refresh admission was cleared");
    this.name = "AbortError";
  }
}

interface QueuedRefresh {
  urgent: () => boolean;
  start: () => void;
  reject: (error: Error) => void;
}

/**
 * Admits at most `concurrency` workspace refreshes at a time, first come first served, except that
 * a queued refresh a client is waiting on goes ahead of the rest. Urgency is read when a slot
 * frees, so a refresh queued long before the client asked still moves up.
 */
export class WorkspaceRefreshAdmission {
  private active = 0;
  private readonly queue: QueuedRefresh[] = [];

  constructor(private readonly concurrency: number) {}

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  run<T>(task: () => T | PromiseLike<T>, urgent: () => boolean): Promise<T> {
    // A queued refresh starts from whichever refresh freed its slot. Run it in its own caller's
    // async context, as p-limit did: Git priority and provenance travel there, and would
    // otherwise pass from one refresh to the next.
    const inCallerContext = AsyncLocalStorage.snapshot();
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active += 1;
        void Promise.resolve()
          .then(() => inCallerContext(task))
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.admitNext();
          });
      };
      this.queue.push({ urgent, start, reject });
      this.admitNext();
    });
  }

  clearQueue(): void {
    for (const queued of this.queue.splice(0)) {
      queued.reject(new WorkspaceRefreshAdmissionClearedError());
    }
  }

  private admitNext(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const urgentIndex = this.queue.findIndex((queued) => queued.urgent());
      const [next] = this.queue.splice(Math.max(0, urgentIndex), 1);
      next?.start();
    }
  }
}
