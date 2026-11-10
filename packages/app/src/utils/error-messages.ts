export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

const MAX_LOGGED_ERROR_LENGTH = 500;

function readErrorCode(error: Error): string | null {
  if (!("code" in error)) return null;
  const { code } = error;
  if (typeof code === "string" || typeof code === "number") return String(code);
  return null;
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    const code = readErrorCode(error);
    const label = code ? `${error.name}[${code}]` : error.name;
    return `${label}: ${error.message}`;
  }
  if (typeof error !== "object" || error === null) return String(error);
  try {
    return JSON.stringify(error);
  } catch {
    // Circular or BigInt-bearing objects cannot be serialized.
    return String(error);
  }
}

/**
 * One line for `console.*`. The desktop log receives renderer console arguments already
 * flattened to text, so an object argument arrives there as "[object Object]".
 */
export function describeErrorForLog(error: unknown): string {
  const described = describeUnknownError(error).replace(/\s+/g, " ").trim();
  if (described.length <= MAX_LOGGED_ERROR_LENGTH) return described;
  return `${described.slice(0, MAX_LOGGED_ERROR_LENGTH - 1)}…`;
}
