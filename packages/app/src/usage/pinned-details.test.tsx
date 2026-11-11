import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProviderPinnedUsage } from "./pinned";
import { PinnedUsageDetails } from "./pinned-details";
import type { UsagePreferences } from "./preferences";
import type { UsageReportEntry, UsageWindow } from "./types";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12 },
    fontSize: { sm: 12 },
    fontWeight: { semibold: "600" },
    borderWidth: { 1: 1 },
    borderRadius: { full: 9999 },
    colors: {
      foreground: "#111111",
      foregroundMuted: "#666666",
      popoverForeground: "#222222",
      borderAccent: "#a1a1aa",
      surface3: "#e4e4e7",
      surface4: "#d4d4d8",
      statusSuccess: "#15803d",
      statusWarning: "#d97706",
      statusDanger: "#b91c1c",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
}));

// The icon is the catalog's SVG; what matters here is where it sits.
vi.mock("./source-icon", async () => {
  const { View } = await import("react-native");
  return { UsageSourceIcon: () => React.createElement(View, { testID: "usage-source-icon" }) };
});

function report(input: {
  sourceId: string;
  sourceLabel: string;
  account?: string;
  windows: UsageWindow[];
}): UsageReportEntry {
  return {
    id: `${input.sourceId}:${input.account ?? "default"}`,
    account: input.account ? { label: input.account } : {},
    fetchedAt: "2026-11-11T00:00:00.000Z",
    sourceId: input.sourceId,
    sourceLabel: input.sourceLabel,
    report: { status: "available", windows: input.windows },
  };
}

const local = (month: number, day: number, hour: number, minute: number) =>
  new Date(2026, month - 1, day, hour, minute).toISOString();
const now = new Date(2026, 10, 11, 11, 0).getTime();

const reports = [
  report({
    sourceId: "claude",
    sourceLabel: "Claude",
    account: "claudecodelover@gmail.com",
    windows: [
      { id: "five_hour", label: "Session", usedPct: 12, resetsAt: local(11, 11, 15, 30) },
      { id: "weekly", label: "Weekly", usedPct: 75, resetsAt: local(11, 14, 13, 0) },
    ],
  }),
  report({
    sourceId: "claude",
    sourceLabel: "Claude",
    account: "claudecodelover2@gmail.com",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 95, resetsAt: local(11, 17, 15, 0) }],
  }),
  report({
    sourceId: "codex",
    sourceLabel: "Codex",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 48 }],
  }),
];

const preferences: UsagePreferences = {
  displayAs: "used",
  serverId: null,
  pins: [
    { sourceId: "claude", windowId: "five_hour" },
    { sourceId: "claude", windowId: "weekly" },
    { sourceId: "codex", windowId: "weekly" },
  ],
};

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
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function render() {
  const providers = resolveProviderPinnedUsage(reports, preferences, now);
  act(() => {
    root?.render(<PinnedUsageDetails providers={providers} displayAs="used" />);
  });
}

function byTestId(scope: ParentNode, testID: string): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(`[data-testid="${testID}"]`)];
}

/** A window row as its cells read: name, meter (no text), percent, reset. */
function cells(row: HTMLElement): string[] {
  return [...row.children].map((cell) => cell.textContent ?? "");
}

describe("PinnedUsageDetails", () => {
  it("lays out providers, then accounts, then a row per window", () => {
    render();
    const providers = byTestId(container!, "sidebar-usage-detail-provider");

    expect(container!.textContent).toMatch(/^사용량남은 양/);
    expect(providers.map((provider) => provider.firstElementChild?.textContent)).toEqual([
      "Claude",
      "Codex",
    ]);
    expect(byTestId(providers[0], "usage-source-icon")).toHaveLength(1);

    const claudeAccounts = byTestId(providers[0], "sidebar-usage-detail-account");
    expect(claudeAccounts.map((account) => account.firstElementChild?.textContent)).toEqual([
      "claudecodelover@gmail.com",
      "claudecodelover2@gmail.com",
    ]);
    expect(
      claudeAccounts.map((account) => byTestId(account, "sidebar-usage-detail-row").length),
    ).toEqual([2, 1]);
    const claudeRows = claudeAccounts.flatMap((account) =>
      byTestId(account, "sidebar-usage-detail-row"),
    );
    expect(claudeRows.map((row) => cells(row).slice(0, 3))).toEqual([
      ["5시간", "", "12% 사용"],
      ["주간", "", "75% 사용"],
      ["주간", "", "95% 사용"],
    ]);
    expect(cells(claudeRows[1])[3]).toMatch(/^11\. 14\. \(토\) (오후 01:00|13:00) · 3일 후$/);
  });

  it("leaves out the account line and reset column a source has nothing for", () => {
    render();
    const [, codex] = byTestId(container!, "sidebar-usage-detail-provider");
    const [account] = byTestId(codex, "sidebar-usage-detail-account");
    const rows = byTestId(account, "sidebar-usage-detail-row");

    expect(account.firstElementChild).toBe(rows[0]);
    expect(rows.map(cells)).toEqual([["주간", "", "48% 사용"]]);
  });

  it("colours a percent by its window's tone and divides providers with a rule", () => {
    render();
    const [claude, codex] = byTestId(container!, "sidebar-usage-detail-provider");
    const percent = (row: HTMLElement) => (row.children[2] as HTMLElement).style.color;
    const rows = byTestId(claude, "sidebar-usage-detail-row");

    expect(rows.map(percent)).toEqual(["rgb(34, 34, 34)", "rgb(217, 119, 6)", "rgb(185, 28, 28)"]);
    expect(claude.style.borderTopWidth).toBe("");
    expect(codex.style.borderTopWidth).toBe("1px");
  });
});
