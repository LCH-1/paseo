import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { shortenPath } from "@/utils/shorten-path";

export function formatHistoryPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return shortenPath(normalized)
    .replace(/^[A-Za-z]:\/Users\/[^/]+(?=\/|$)/i, "~")
    .replace(/^\/root(?=\/|$)/, "~");
}

export function isHistoryAgentWorking(agent: Pick<AggregatedAgent, "status" | "turn">): boolean {
  return agent.status === "running" || agent.turn.phase === "open";
}
