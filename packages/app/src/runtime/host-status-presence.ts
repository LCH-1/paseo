import type { HostRuntimeConnectionStatus } from "./host-runtime";

type Statuses = Record<string, HostRuntimeConnectionStatus>;
interface Presence {
  receivedAt: number;
  statuses: Statuses;
}

/** Display-only observations. They never supply a client or authorize host operations. */
export class HostStatusPresence {
  private readonly peers = new Map<string, Presence>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now = Date.now) {}

  receive(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const { owner, statuses, closed } = value as Record<string, unknown>;
    if (typeof owner !== "string") return;
    if (closed === true) {
      this.peers.delete(owner);
    } else {
      if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) return;
      const valid: Statuses = {};
      for (const [id, status] of Object.entries(statuses)) {
        if (["idle", "connecting", "online", "offline", "error"].includes(String(status))) {
          valid[id] = status as HostRuntimeConnectionStatus;
        }
      }
      this.peers.set(owner, { receivedAt: this.now(), statuses: valid });
    }
    this.notify();
  }

  status(
    serverId: string,
    local: HostRuntimeConnectionStatus | undefined,
  ): HostRuntimeConnectionStatus {
    if (local === "online") return local;
    let latest: Presence | undefined;
    for (const peer of this.peers.values()) {
      if (this.now() - peer.receivedAt >= 25_000) continue;
      if (peer.statuses[serverId] === "online") return "online";
      if (peer.statuses[serverId] && (!latest || latest.receivedAt < peer.receivedAt))
        latest = peer;
    }
    return local ?? latest?.statuses[serverId] ?? "idle";
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** One channel per window; other project windows do not need extra host connections. */
export function shareWindowHostStatuses(input: {
  presence: HostStatusPresence;
  read: () => Statuses;
  subscribe: (listener: () => void) => () => void;
}): () => void {
  const channel = new BroadcastChannel("paseo:host-status:v1");
  const send = channel.postMessage.bind(channel);
  const owner = crypto.randomUUID();
  let last = "";
  const publish = (force = false) => {
    const statuses = input.read();
    const serialized = JSON.stringify(statuses);
    if (!force && last === serialized) return;
    last = serialized;
    send({ owner, statuses });
  };
  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (message && typeof message === "object" && Reflect.get(message, "request") === true) {
      publish(true);
    } else input.presence.receive(message);
  });
  const unsubscribe = input.subscribe(() => publish());
  const heartbeat = setInterval(() => {
    publish(true);
    input.presence.notify();
  }, 10_000);
  publish(true);
  send({ request: true });
  return () => {
    clearInterval(heartbeat);
    unsubscribe();
    send({ owner, closed: true });
    channel.close();
  };
}
