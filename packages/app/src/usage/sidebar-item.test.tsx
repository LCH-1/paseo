import { JSDOM } from "jsdom";
import React, { act, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UsagePreferences } from "./preferences";
import { UsageSidebarItem, UsageSidebarRoot } from "./sidebar-item";
import type { UsageReportEntry } from "./types";

const { theme, tooltip, reportQueries, reports, preferences } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const tooltipState = {
    open: false,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOpen(open: boolean) {
      tooltipState.open = open;
      for (const listener of listeners) listener();
    },
  };
  const usageReports: UsageReportEntry[] = [
    {
      id: "claude:one",
      account: { label: "one@example.com" },
      fetchedAt: "2026-11-11T00:00:00.000Z",
      sourceId: "claude",
      sourceLabel: "Claude",
      report: {
        status: "available",
        windows: [{ id: "weekly", label: "Weekly", usedPct: 60 }],
      },
    },
  ];
  const usagePreferences: UsagePreferences = {
    displayAs: "used",
    serverId: null,
    pins: [{ sourceId: "claude", windowId: "weekly" }],
  };
  return {
    theme: {
      spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12 },
      fontSize: { sm: 12 },
      fontWeight: { normal: "normal", semibold: "600" },
      iconSize: { sm: 14 },
      borderWidth: { 1: 1 },
      borderRadius: { lg: 8, full: 9999 },
      colors: {
        foregroundMuted: "#666666",
        popoverForeground: "#222222",
        borderAccent: "#a1a1aa",
        surface3: "#e4e4e7",
        surface4: "#d4d4d8",
        surfaceSidebarHover: "#f4f4f5",
        statusSuccess: "#15803d",
        statusWarning: "#d97706",
        statusDanger: "#b91c1c",
      },
    },
    tooltip: tooltipState,
    // Each mount is a reports query observer, which the app's fetch queries refetch on.
    reportQueries: { mounted: 0 },
    reports: usageReports,
    preferences: usagePreferences,
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/sidebar-nav/model", () => ({ builtinSidebarNavLabelKey: () => "Usage" }));
vi.mock("./usage-modal", () => ({ UsageModal: () => null }));
vi.mock("./hosts", () => ({ useUsageHostId: () => "host" }));

function useMountedReportQuery(): UsageReportEntry[] {
  useEffect(() => {
    reportQueries.mounted += 1;
  }, []);
  return reports;
}

vi.mock("./queries", () => ({ useUsageHostReports: () => useMountedReportQuery() }));
// Like the real hook, it reads the usage host's reports to resolve the pins.
vi.mock("./display", () => ({
  useUsagePreferences: () => {
    useMountedReportQuery();
    return { preferences };
  },
}));

vi.mock("./source-icon", async () => {
  const { View } = await import("react-native");
  return { UsageSourceIcon: () => React.createElement(View, { testID: "usage-source-icon" }) };
});

// The hover card mounts while the tooltip is open, as the real one does.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => {
    const open = useSyncExternalStore(tooltip.subscribe, () => tooltip.open);
    return open ? children : null;
  },
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  tooltip.setOpen(false);
  reportQueries.mounted = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

it("opens the hover card on the reports the item holds, without a reports query of its own", () => {
  act(() => {
    root?.render(
      <UsageSidebarRoot>
        <UsageSidebarItem />
      </UsageSidebarRoot>,
    );
  });
  const queriesWhileClosed = reportQueries.mounted;
  expect(container!.querySelector('[data-testid="sidebar-usage-detail-row"]')).toBeNull();

  act(() => tooltip.setOpen(true));

  const [row] = container!.querySelectorAll('[data-testid="sidebar-usage-detail-row"]');
  expect(row?.textContent).toMatch(/^주간60% 사용/);
  expect(reportQueries.mounted).toBe(queriesWhileClosed);
});
