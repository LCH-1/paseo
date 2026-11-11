import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { Agent } from "@/stores/session-store";

const EMPTY_AGENTS: ReadonlyMap<string, Agent> = new Map();
const cache = new WeakMap<
  ReadonlyMap<string, Agent>,
  WeakMap<ReadonlyMap<string, ProviderSubagentDescriptorPayload>, Map<string, ReadonlySet<string>>>
>();

/** Shared across tab selectors; stream-only updates do not rebuild the family index. */
export function getRunningAgentFamilies(
  agents: ReadonlyMap<string, Agent> | undefined,
  descriptors: ReadonlyMap<string, ProviderSubagentDescriptorPayload>,
  serverId: string,
): ReadonlySet<string> {
  const directory = agents ?? EMPTY_AGENTS;
  let byDescriptors = cache.get(directory);
  if (!byDescriptors) {
    byDescriptors = new WeakMap();
    cache.set(directory, byDescriptors);
  }
  let byServer = byDescriptors.get(descriptors);
  if (!byServer) {
    byServer = new Map();
    byDescriptors.set(descriptors, byServer);
  }
  const previous = byServer.get(serverId);
  if (previous) return previous;
  const running = new Set<string>();
  const addFamily = (id: string) => {
    let current = directory.get(id);
    while (
      current &&
      current.serverId === serverId &&
      !current.archivedAt &&
      !running.has(current.id)
    ) {
      running.add(current.id);
      const parent = current.parentAgentId ? directory.get(current.parentAgentId) : undefined;
      // A child assigned to another workspace is that workspace's independent root.
      if (current.workspaceId && parent?.workspaceId && current.workspaceId !== parent.workspaceId)
        break;
      current = parent;
    }
  };
  for (const agent of directory.values()) if (agent.turn.phase === "open") addFamily(agent.id);
  const prefix = `${serverId}\0`;
  for (const [key, child] of descriptors) {
    if (key.startsWith(prefix) && child.status === "running") addFamily(child.parentAgentId);
  }
  byServer.set(serverId, running);
  return running;
}
