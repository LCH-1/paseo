import { expect, test } from "vitest";
import { SessionInboundMessageSchema } from "./messages";

test("a creation failure lookup names the provider and model a new session would use", () => {
  const parsed = SessionInboundMessageSchema.parse({
    type: "creation.find_failed.request",
    requestId: "req-1",
    workspaceId: "wks_1",
    provider: "claude",
    model: "claude-fable-5-2",
  });

  expect(parsed).toEqual({
    type: "creation.find_failed.request",
    requestId: "req-1",
    workspaceId: "wks_1",
    provider: "claude",
    model: "claude-fable-5-2",
  });
});

test("a creation failure lookup from an app that names no model still parses", () => {
  const parsed = SessionInboundMessageSchema.parse({
    type: "creation.find_failed.request",
    requestId: "req-2",
    workspaceId: "wks_1",
    provider: "claude",
  });

  expect(parsed).toEqual({
    type: "creation.find_failed.request",
    requestId: "req-2",
    workspaceId: "wks_1",
    provider: "claude",
  });
});
