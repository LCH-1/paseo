/** Only the daemon's explicit entity-deletion code is terminal for timeline demand. */
export function isAgentNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "agent_not_found"
  );
}

export function agentNotFoundError(agentId: string): Error & { code: "agent_not_found" } {
  return Object.assign(new Error(`Agent not found: ${agentId}`), {
    code: "agent_not_found" as const,
  });
}
