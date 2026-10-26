import { expect, it } from "vitest";
import { formatHistoryPath, isHistoryAgentWorking } from "./history-presentation";

it.each([
  ["C:\\Users\\derek\\Desktop/projects\\paseo", "~/Desktop/projects/paseo"],
  ["c:/users/derek", "~"],
  ["/Users/derek/project", "~/project"],
  ["/home/derek/project", "~/project"],
  ["/root/project", "~/project"],
  ["/rooted/project", "/rooted/project"],
  ["D:\\projects\\paseo", "D:/projects/paseo"],
  ["\\\\server\\share\\project", "//server/share/project"],
  ["~/projects\\paseo", "~/projects/paseo"],
])("formats %s without changing the stored path", (input, expected) => {
  expect(formatHistoryPath(input)).toBe(expected);
});

it("shows working for a running provider or an open turn and returns to elapsed time when idle", () => {
  expect(
    isHistoryAgentWorking({
      status: "running",
      turn: { phase: "idle", cancellationRequestId: null },
    }),
  ).toBe(true);
  expect(
    isHistoryAgentWorking({
      status: "idle",
      turn: { phase: "open", cancellationRequestId: null },
    } as Parameters<typeof isHistoryAgentWorking>[0]),
  ).toBe(true);
  expect(
    isHistoryAgentWorking({ status: "idle", turn: { phase: "idle", cancellationRequestId: null } }),
  ).toBe(false);
});
