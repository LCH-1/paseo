import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

export async function markActivitySessionsRead(
  agents: readonly Pick<AggregatedAgent, "id" | "serverId">[],
  getClient: (serverId: string) => Pick<DaemonClient, "clearAgentAttention"> | null,
): Promise<number> {
  let next = 0;
  let failed = 0;
  const work = async () => {
    while (next < agents.length) {
      const agent = agents[next++];
      try {
        const client = getClient(agent.serverId);
        if (!client) {
          failed++;
          continue;
        }
        await client.clearAgentAttention(agent.id);
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, agents.length) }, work));
  return failed;
}
