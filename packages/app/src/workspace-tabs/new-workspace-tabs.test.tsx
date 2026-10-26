/** @vitest-environment jsdom */
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { type ReactNode } from "react";
import { router } from "expo-router";
import { useDraftStore } from "@/stores/draft-store";
import { buildNewWorkspaceDraftKey } from "@/stores/draft-keys";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  adoptLegacyNewWorkspaceDraft,
  completeNewWorkspaceLaunch,
  completeNewWorkspaceTab,
  NewWorkspaceTabsBar,
  newWorkspaceTabsBridge as bridge,
  useNewWorkspaceTabPresence,
  useHistoryTabPresence,
} from "./new-workspace-tabs";
import {
  clearNewWorkspaceDraftState,
  createNewWorkspaceDraftState,
  NewWorkspaceDraftScope,
  useNewWorkspaceDraftState,
} from "./new-workspace-draft-state";

const route = vi.hoisted(() => ({ focused: true, pathname: "/new" }));
vi.mock("expo-router", () => ({
  router: { push: vi.fn(), navigate: vi.fn() },
  usePathname: () => route.pathname,
  useLocalSearchParams: () => ({ serverId: "host-a" }),
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => route.focused }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  getLastWorkspaceSelection: () => null,
}));
vi.mock("@/workspace-tabs/launcher", () => ({
  NewTabLauncherProvider: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  cleanup();
  for (const entry of bridge.getSnapshot().entries) bridge.close(entry.draftId);
  useDraftStore.setState({ drafts: {} });
  useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
  route.focused = true;
  route.pathname = "/new";
  vi.clearAllMocks();
});

it("keeps one history tab across navigation and closes it without clearing a composer draft", () => {
  route.pathname = "/sessions";
  const presence = renderHook(() => useHistoryTabPresence());
  expect(bridge.getSnapshot().entries).toEqual([
    { draftId: "history", serverId: "", href: "/sessions", kind: "history" },
  ]);
  expect(bridge.getSnapshot().activeDraftId).toBe("history");
  presence.unmount();
  expect(bridge.getSnapshot().entries).toHaveLength(1);
  const second = renderHook(() => useHistoryTabPresence());
  expect(bridge.getSnapshot().entries).toHaveLength(1);
  act(() => bridge.activate("history"));
  expect(router.navigate).toHaveBeenCalledWith("/sessions");
  act(() => bridge.close("history"));
  expect(bridge.getSnapshot().entries).toHaveLength(0);
  second.unmount();
});

describe("new workspace tab ownership", () => {
  it("opens independent drafts and keeps snapshots stable until a change", () => {
    const before = bridge.getSnapshot();
    expect(bridge.getSnapshot()).toBe(before);
    const first = bridge.open({ serverId: "host-a", projectId: "project-a" });
    const second = bridge.open({ serverId: "host-b" });
    expect(first).not.toBe(second);
    expect(bridge.getSnapshot().entries.map((entry) => entry.draftId)).toEqual([first, second]);
    const firstHref = bridge.getSnapshot().entries[0].href;
    expect(new URL(firstHref, "http://localhost").searchParams.get("draftId")).toBe(first);
    bridge.activate(first);
    expect(router.navigate).toHaveBeenCalledWith(firstHref);
    bridge.close(first);
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(bridge.getSnapshot().entries.map((entry) => entry.draftId)).toEqual([second]);
  });

  it("does not recreate a closed draft when its hidden route observes a workspace navigation", () => {
    const draftId = bridge.open({ serverId: "host-a" });
    const href = bridge.getSnapshot().entries[0].href;
    const view = renderHook(() =>
      useNewWorkspaceTabPresence({ draftId, href, serverId: "host-a" }),
    );
    expect(bridge.getSnapshot().activeDraftId).toBe(draftId);
    act(() => bridge.close(draftId));
    route.focused = false;
    route.pathname = "/h/host-a/workspace/existing";
    view.rerender();
    expect(bridge.getSnapshot().entries).toEqual([]);
    expect(bridge.getSnapshot().activeDraftId).toBeNull();
  });

  it("preserves saved text on close and ignores a closed draft's late completion", () => {
    const draftId = bridge.open({ serverId: "host-a" });
    const draftKey = buildNewWorkspaceDraftKey(draftId);
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey, draft: { text: "작성 중인 내용", attachments: [] } });
    bridge.close(draftId);
    const closed = bridge.getSnapshot();
    completeNewWorkspaceTab({
      draftId,
      serverId: "host-a",
      workspaceId: "late-workspace",
      target: { kind: "agent", agentId: "late-agent" },
    });
    expect(bridge.getSnapshot()).toBe(closed);
    expect(useDraftStore.getState().getDraftInput(draftKey)).toEqual({
      text: "작성 중인 내용",
      attachments: [],
    });
  });

  it("keeps the exact handoff tab identity and ignores late success after closing the handoff", () => {
    const draftId = bridge.open({ serverId: "host-a" });
    const tabId = useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: "host-a:workspace-a",
      target: { kind: "draft", draftId },
      intent: "new",
    });
    completeNewWorkspaceTab({
      draftId,
      serverId: "host-a",
      workspaceId: "workspace-a",
      target: { kind: "draft", draftId },
    });
    expect(bridge.getSnapshot().completions.at(-1)?.tabId).toBe(tabId);
    const handoff = bridge.getSnapshot();
    bridge.close(draftId);
    completeNewWorkspaceTab({
      draftId,
      serverId: "host-a",
      workspaceId: "workspace-a",
      target: { kind: "agent", agentId: "closed-agent" },
    });
    expect(bridge.getSnapshot()).toBe(handoff);
  });

  it("emits ordered exact draft and agent completion records without changing another draft", () => {
    const draftId = bridge.open({ serverId: "host-a" });
    const another = bridge.open({ serverId: "host-b" });
    const start = bridge.getSnapshot().completions.at(-1)?.sequence ?? 0;
    completeNewWorkspaceTab({
      draftId,
      serverId: "host-a",
      workspaceId: "workspace-a",
      target: { kind: "draft", draftId },
    });
    completeNewWorkspaceTab({
      draftId,
      serverId: "host-a",
      workspaceId: "workspace-a",
      target: { kind: "agent", agentId: "created-agent" },
      tabId: draftId,
    });
    const completions = bridge.getSnapshot().completions.slice(-2);
    expect(completions.map((entry) => entry.sequence)).toEqual([start + 1, start + 2]);
    expect(completions[1]).toEqual({
      sequence: start + 2,
      draftId,
      serverId: "host-a",
      workspaceId: "workspace-a",
      target: { kind: "agent", agentId: "created-agent" },
      tabId: draftId,
    });
    expect(bridge.getSnapshot().entries.map((entry) => entry.draftId)).toEqual([another]);
  });

  it("reports an empty workspace completion without inventing a tab target", () => {
    const draftId = bridge.open({ serverId: "host-a" });
    completeNewWorkspaceTab({
      draftId,
      serverId: "host-a",
      workspaceId: "empty-workspace",
      target: null,
    });
    expect(bridge.getSnapshot().completions.at(-1)).toMatchObject({
      draftId,
      serverId: "host-a",
      workspaceId: "empty-workspace",
      target: null,
      tabId: null,
    });
  });

  it.each([null, { kind: "terminal", terminalId: "terminal-a" }] as const)(
    "checks presence before completing and navigates after the %j completion",
    (target) => {
      const draftId = bridge.open({ serverId: "host-a" });
      const href = bridge.getSnapshot().entries[0].href;
      renderHook(() => useNewWorkspaceTabPresence({ draftId, href, serverId: "host-a" }));
      const events: string[] = [];
      const remove = bridge.subscribe(() => events.push("completion"));
      act(() =>
        completeNewWorkspaceLaunch(
          { draftId, serverId: "host-a", workspaceId: "created-workspace", target },
          {
            isCurrent: () => bridge.getSnapshot().activeDraftId === draftId,
            navigate: () => events.push("navigate"),
          },
        ),
      );
      remove();
      expect(events).toEqual(["completion", "navigate"]);
      expect(bridge.getSnapshot().activeDraftId).toBeNull();
    },
  );

  it("does not navigate when a pending creation completes after switching drafts", () => {
    const draftId = bridge.open({ serverId: "host-a" });
    const another = bridge.open({ serverId: "host-b" });
    const href = bridge.getSnapshot().entries[1].href;
    renderHook(() => useNewWorkspaceTabPresence({ draftId: another, href, serverId: "host-b" }));
    const navigate = vi.fn();
    act(() =>
      completeNewWorkspaceLaunch(
        { draftId, serverId: "host-a", workspaceId: "background-workspace", target: null },
        {
          isCurrent: () => bridge.getSnapshot().activeDraftId === draftId,
          navigate,
        },
      ),
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(bridge.getSnapshot().activeDraftId).toBe(another);
  });

  it("clones a legacy draft without deleting it or overwriting a newer explicit draft", async () => {
    const legacy = buildNewWorkspaceDraftKey();
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey: legacy, draft: { text: "기존 작성 내용", attachments: [] } });
    await adoptLegacyNewWorkspaceDraft("adopted-draft");
    expect(
      useDraftStore.getState().getDraftInput(buildNewWorkspaceDraftKey("adopted-draft"))?.text,
    ).toBe("기존 작성 내용");
    expect(useDraftStore.getState().getDraftInput(legacy)?.text).toBe("기존 작성 내용");
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey: legacy, draft: { text: "다른 기존 내용", attachments: [] } });
    const targetKey = buildNewWorkspaceDraftKey("existing-draft");
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey: targetKey, draft: { text: "더 최근 입력", attachments: [] } });
    await adoptLegacyNewWorkspaceDraft("existing-draft");
    expect(useDraftStore.getState().getDraftInput(targetKey)?.text).toBe("더 최근 입력");
  });
});

function FirstBar() {
  return <span>First bar</span>;
}
function SecondBar() {
  return <span>Second bar</span>;
}

it("removes registered bars idempotently without removing a later registration", () => {
  const draftId = bridge.open({ serverId: "host-a" });
  const href = bridge.getSnapshot().entries[0].href;
  const presence = renderHook(() =>
    useNewWorkspaceTabPresence({ draftId, href, serverId: "host-a" }),
  );
  const first = bridge.registerTabBar(FirstBar);
  const second = bridge.registerTabBar(SecondBar);
  const view = render(<NewWorkspaceTabsBar />);
  expect(view.getByText("Second bar").textContent).toBe("Second bar");
  act(() => {
    first();
    first();
  });
  expect(view.getByText("Second bar").textContent).toBe("Second bar");
  act(() => {
    second();
    second();
  });
  expect(view.queryByText("Second bar")).toBeNull();
  presence.unmount();
});

function DraftA({ children }: { children: ReactNode }) {
  return <NewWorkspaceDraftScope draftId="draft-a">{children}</NewWorkspaceDraftScope>;
}
function DraftB({ children }: { children: ReactNode }) {
  return <NewWorkspaceDraftScope draftId="draft-b">{children}</NewWorkspaceDraftScope>;
}

it("retains each draft's native form state across unmount and background state updates", () => {
  const store = createNewWorkspaceDraftState<{
    project: string;
    terminalPrompt: string;
    pending: boolean;
  }>();
  const first = renderHook(
    () =>
      useNewWorkspaceDraftState(store, () => ({
        project: "initial",
        terminalPrompt: "",
        pending: false,
      })),
    { wrapper: DraftA },
  );
  act(() =>
    first.result.current[1]({ project: "payments", terminalPrompt: "pnpm dev", pending: true }),
  );
  const updateAfterUnmount = first.result.current[1];
  first.unmount();
  const second = renderHook(
    () =>
      useNewWorkspaceDraftState(store, () => ({
        project: "other",
        terminalPrompt: "",
        pending: false,
      })),
    { wrapper: DraftB },
  );
  expect(second.result.current[0].project).toBe("other");
  second.unmount();
  updateAfterUnmount((state) => ({ ...state, pending: false }));
  const resumed = renderHook(
    () =>
      useNewWorkspaceDraftState(store, () => ({
        project: "wrong",
        terminalPrompt: "",
        pending: true,
      })),
    { wrapper: DraftA },
  );
  expect(resumed.result.current[0]).toEqual({
    project: "payments",
    terminalPrompt: "pnpm dev",
    pending: false,
  });
  resumed.unmount();
  clearNewWorkspaceDraftState("draft-a");
  updateAfterUnmount((state) => ({ ...state, pending: true }));
  const closed = renderHook(
    () =>
      useNewWorkspaceDraftState(store, () => ({
        project: "fresh",
        terminalPrompt: "",
        pending: false,
      })),
    { wrapper: DraftA },
  );
  expect(closed.result.current[0].project).toBe("fresh");
});
