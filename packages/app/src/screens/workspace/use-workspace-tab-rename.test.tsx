// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { QueryClient } from "@tanstack/react-query";
import { useWorkspaceTabRename } from "./use-workspace-tab-rename";

const mocks = vi.hoisted(() => ({
  setWorkspaceTitle: vi.fn(),
  updateAgent: vi.fn(),
  getClient: vi.fn(),
  state: {
    sessions: {
      first: {
        agents: new Map([["a", { workspaceId: "actual" }]]),
        agentDetails: new Map(),
        workspaces: new Map([["actual", { name: "main", title: "Sidebar name" }]]),
      },
    },
  },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/rename-modal", () => ({ AdaptiveRenameModal: () => null }));
vi.mock("@/stores/session-store", () => ({ useSessionStore: { getState: () => mocks.state } }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: mocks.getClient }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getClient.mockReturnValue({
    setWorkspaceTitle: mocks.setWorkspaceTitle,
    updateAgent: mocks.updateAgent,
  });
});

it("renames the workspace displayed by both tab and sidebar, retaining the modal's original host after navigation", async () => {
  const { result, rerender } = renderHook(
    ({ serverId }) =>
      useWorkspaceTabRename({
        client: null,
        normalizedServerId: serverId,
        normalizedWorkspaceId: "route-workspace",
        queryClient: {} as QueryClient,
        terminalsData: undefined,
        terminalsQueryKey: [],
      }),
    { initialProps: { serverId: "first" } },
  );
  act(() =>
    result.current.handleRenameTab({
      key: "a",
      tabId: "a",
      kind: "agent",
      target: { kind: "agent", agentId: "a" },
    }),
  );
  expect(result.current.renamingTab?.currentTitle).toBe("Sidebar name");
  rerender({ serverId: "another-host" });
  await act(async () => result.current.handleRenameModalSubmit("  Unified name  "));
  expect(mocks.getClient).toHaveBeenCalledWith("first");
  expect(mocks.setWorkspaceTitle).toHaveBeenCalledWith("actual", "Unified name");
  expect(mocks.updateAgent).not.toHaveBeenCalled();
});

it("keeps terminal rename separate from workspace names", async () => {
  const renameTerminal = vi.fn().mockResolvedValue({ success: true });
  const invalidateQueries = vi.fn();
  const { result } = renderHook(() =>
    useWorkspaceTabRename({
      client: { renameTerminal } as unknown as DaemonClient,
      normalizedServerId: "first",
      normalizedWorkspaceId: "actual",
      queryClient: { invalidateQueries } as unknown as QueryClient,
      terminalsData: undefined,
      terminalsQueryKey: ["terminals"],
    }),
  );
  act(() =>
    result.current.handleRenameTab({
      key: "t",
      tabId: "t",
      kind: "terminal",
      target: { kind: "terminal", terminalId: "t" },
    }),
  );
  await act(async () => result.current.handleRenameModalSubmit(" shell "));
  expect(renameTerminal).toHaveBeenCalledWith({ terminalId: "t", title: "shell" });
  expect(mocks.setWorkspaceTitle).not.toHaveBeenCalled();
});
