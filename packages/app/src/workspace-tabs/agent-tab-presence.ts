export interface AgentTabPresence {
  isOpen: boolean;
  lastClosedAt: number | null;
}
interface PresenceSource {
  read(serverId: string, agentId: string): AgentTabPresence;
  subscribe(listener: () => void): () => void;
}
let source: PresenceSource | null = null;
let release: (() => void) | null = null;
let revision = 0;
const listeners = new Set<() => void>();
function notify() {
  revision++;
  for (const listener of listeners) listener();
}

export const agentTabPresenceBridge = {
  read(serverId: string, agentId: string): AgentTabPresence | null {
    return source?.read(serverId, agentId) ?? null;
  },
  getSnapshot: () => revision,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  register(next: PresenceSource) {
    release?.();
    source = next;
    release = next.subscribe(notify);
    notify();
    return () => {
      if (source !== next) return;
      release?.();
      release = null;
      source = null;
      notify();
    };
  },
};
