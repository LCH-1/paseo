import { describe, expect, it } from "vitest";
import { describeErrorForLog } from "./error-messages";

describe("describeErrorForLog", () => {
  it("names the error class, its code and its message", () => {
    class DaemonRpcError extends Error {
      readonly code = "handler_error";
      constructor(message: string) {
        super(message);
        this.name = "DaemonRpcError";
      }
    }

    expect(describeErrorForLog(new DaemonRpcError("Request failed: agent is busy"))).toBe(
      "DaemonRpcError[handler_error]: Request failed: agent is busy",
    );
  });

  it("describes an error without a code by class and message", () => {
    expect(describeErrorForLog(new TypeError("Failed to fetch"))).toBe(
      "TypeError: Failed to fetch",
    );
  });

  it("keeps a multi-line message on one line", () => {
    expect(describeErrorForLog(new Error("Request failed:\n  agent is busy\n"))).toBe(
      "Error: Request failed: agent is busy",
    );
  });

  it("serializes a thrown plain object instead of printing [object Object]", () => {
    expect(describeErrorForLog({ code: "quota_exhausted", retryAfterMs: 5_000 })).toBe(
      '{"code":"quota_exhausted","retryAfterMs":5000}',
    );
  });

  it("falls back to the string form of a value JSON cannot represent", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(describeErrorForLog(circular)).toBe("[object Object]");
    expect(describeErrorForLog("plain text")).toBe("plain text");
    expect(describeErrorForLog(undefined)).toBe("undefined");
  });

  it("truncates a message too long for one log line", () => {
    const described = describeErrorForLog(new Error("x".repeat(2_000)));

    expect(described).toBe(`Error: ${"x".repeat(492)}…`);
    expect(described).toHaveLength(500);
  });
});
