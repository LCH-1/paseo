import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAllByRole, getByRole, queryByRole } from "@testing-library/dom";
import { i18n as testI18n } from "@/i18n/i18next";
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@/stores/panel-store";
import { SidebarProjectEmptyState } from "./empty-states";
import { SidebarActivityPanel } from "./activity/panel";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { navigateToAgent } from "@/utils/navigate-to-agent";

vi.mock("@/hooks/use-aggregated-agents", () => ({ useAggregatedAgents: vi.fn() }));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "activity-host", label: "Host" }],
}));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: vi.fn() }));
vi.mock("@/screens/session-history/use-history-conversations", () => ({
  useHistoryConversations: (agents: AggregatedAgent[]) => ({
    isLoading: false,
    rows: agents.map((agent) => ({
      agent,
      pathLabel: agent.cwd,
      workspaceName: "Shared workspace",
      isWorking: agent.turn.phase === "open",
      isLoading: false,
      isError: false,
      summary: {
        lastRequestAt: Date.parse("2026-10-27T03:00:00Z"),
        lastResponseAt: Date.parse("2026-10-27T03:01:25Z"),
        previewAt: Date.parse("2026-10-27T03:01:25Z"),
        preview: "Recent conversation preview",
      },
    })),
  }),
}));

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  await testI18n.changeLanguage("en");
});

async function mountEmptyState(language: string, width: number): Promise<HTMLElement> {
  await testI18n.changeLanguage(language);

  const container = document.createElement("div");
  container.style.width = `${width}px`;
  // Match the workspace list's horizontal inset around the card.
  container.style.paddingInline = "6px";
  container.style.boxSizing = "border-box";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<SidebarProjectEmptyState />));
  mounted.push({ root, container });

  const card = container.querySelector('[data-testid="sidebar-project-empty-state"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error("SidebarProjectEmptyState did not render its card");
  }
  return card;
}

function expectActionsInsideCard(card: HTMLElement) {
  const cardRect = card.getBoundingClientRect();
  const buttons = getAllByRole(card, "button");

  expect(buttons).toHaveLength(2);
  for (const button of buttons) {
    const rect = button.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(cardRect.left);
    expect(rect.right).toBeLessThanOrEqual(cardRect.right);

    // Containing the button must also keep the whole label readable, without clipping.
    const label = document.createRange();
    label.selectNodeContents(button);
    for (const fragment of Array.from(label.getClientRects())) {
      expect(fragment.left).toBeGreaterThanOrEqual(rect.left);
      expect(fragment.right).toBeLessThanOrEqual(rect.right);
      expect(fragment.top).toBeGreaterThanOrEqual(rect.top);
      expect(fragment.bottom).toBeLessThanOrEqual(rect.bottom);
    }
  }
}

describe("SidebarProjectEmptyState", () => {
  const cases = ["en", "ru", "fr", "ja", "es", "pt-BR", "ar", "ko", "zh-CN"].flatMap((language) =>
    [MIN_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH].map((width) => ({ language, width })),
  );
  it.each(cases)(
    "keeps every action inside the card ($language, $width px sidebar)",
    async ({ language, width }) => {
      expectActionsInsideCard(await mountEmptyState(language, width));
    },
  );

  it("keeps English actions on one row when they fit", async () => {
    const card = await mountEmptyState("en", DEFAULT_SIDEBAR_WIDTH);
    const [addProject, importSession] = getAllByRole(card, "button");
    expect(addProject.getBoundingClientRect().top).toBe(importSession.getBoundingClientRect().top);
  });
});

describe("sidebar activity tabs", () => {
  function agent(id: string, working: boolean): AggregatedAgent {
    return {
      id,
      serverId: "activity-host",
      serverLabel: "Host",
      workspaceId: "shared-workspace",
      title: id,
      cwd: "/repo",
      provider: "codex",
      status: "idle",
      turn: working
        ? { phase: "open", turnId: "turn", startedAt: null, cancellationRequestId: null }
        : { phase: "idle", cancellationRequestId: null },
      requiresAttention: !working,
      attentionReason: working ? null : "finished",
      attentionTimestamp: null,
      pendingPermissionCount: 0,
      archivedAt: null,
      createdAt: new Date("2026-10-27"),
      lastActivityAt: new Date("2026-10-27"),
      labels: {},
    };
  }
  function setAgents(agents: AggregatedAgent[]) {
    vi.mocked(useAggregatedAgents).mockReturnValue({
      agents,
      isLoading: false,
      isInitialLoad: false,
      isRevalidating: false,
      refreshAll: vi.fn(),
    });
  }

  it("switches session lists, preserves the workspace list and opens the exact session at narrow width", async () => {
    await testI18n.changeLanguage("ko");
    setAgents([agent("working-session", true), agent("completed-session", false)]);
    const container = document.createElement("div");
    container.style.cssText = `width:${MIN_SIDEBAR_WIDTH}px;height:600px;display:flex`;
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const onSessionPress = vi.fn();
    const render = () =>
      root.render(
        <SidebarActivityPanel active onSessionPress={onSessionPress}>
          <button type="button">workspace-list</button>
        </SidebarActivityPanel>,
      );
    act(render);
    act(() => getByRole(container, "tab", { name: "전체" }).click());
    const workspaceList = getByRole(container, "button", { name: "workspace-list" });
    const tabs = getAllByRole(container, "tab");
    for (const tab of tabs) {
      const bounds = tab.getBoundingClientRect();
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.left).toBeGreaterThanOrEqual(container.getBoundingClientRect().left);
      expect(bounds.right).toBeLessThanOrEqual(container.getBoundingClientRect().right);
    }

    act(() => getByRole(container, "tab", { name: "작업 중 1" }).click());
    expect(getByRole(container, "tab", { name: "작업 중 1" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(queryByRole(container, "button", { name: "workspace-list" })).toBeNull();
    expect(getByRole(container, "button", { name: "working-session, Host, /repo" })).toBeVisible();
    expect(
      container
        .querySelector('[data-testid="sidebar-activity-requested-at"]')
        ?.getAttribute("data-timestamp"),
    ).toBe("2026-10-27T03:00:00.000Z");
    expect(
      container.querySelector('[data-testid="sidebar-activity-completed-at"]')?.textContent,
    ).toContain("진행 중");
    expect(container.textContent).toContain("codex · Shared workspace");
    expect(container.textContent).toContain("Recent conversation preview");
    act(() => getByRole(container, "tab", { name: "미확인 1" }).click());
    expect(
      container
        .querySelector('[data-testid="sidebar-activity-completed-at"]')
        ?.getAttribute("data-timestamp"),
    ).toBe("2026-10-27T03:01:25.000Z");
    expect(
      container.querySelector('[data-testid="sidebar-activity-duration"]')?.textContent,
    ).toContain("1분 25초");
    act(() => getByRole(container, "button", { name: "completed-session, Host, /repo" }).click());
    expect(navigateToAgent).toHaveBeenCalledWith({
      serverId: "activity-host",
      agentId: "completed-session",
      workspaceId: "shared-workspace",
      pin: true,
    });
    expect(onSessionPress).toHaveBeenCalledTimes(1);

    setAgents([{ ...agent("completed-session", false), requiresAttention: false }]);
    act(render);
    expect(getByRole(container, "tab", { name: "미확인 0" })).toBeVisible();
    expect(container.textContent).toContain("완료 후 확인하지 않은 세션이 없습니다.");
    act(() => getByRole(container, "tab", { name: "전체" }).click());
    expect(getByRole(container, "button", { name: "workspace-list" })).toBe(workspaceList);
  });
});
