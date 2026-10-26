/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeRelativeTimeTickerCount } from "@/utils/relative-time-ticker";
import {
  resolveWorkspaceTabTitleLines,
  workspaceTabTitleSignature,
  WorkspaceTabTitle,
} from "./workspace-tab-title";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const titleLines = { primaryLabel: "결제 프로젝트 🧩", secondaryLabel: "main" };

describe("workspace tab title", () => {
  it("renders independent ellipsized project and workspace rows", () => {
    const view = render(
      <WorkspaceTabTitle label="combined" titleLines={titleLines} labelStyle={{}} />,
    );
    const primary = view.getByTestId("agent-tab-title-line-primary");
    const secondary = view.getByTestId("agent-tab-title-line-secondary");
    expect(primary.textContent).toBe(titleLines.primaryLabel);
    expect(secondary.textContent).toBe(titleLines.secondaryLabel);
    expect(primary.parentElement?.parentElement).toBe(secondary.parentElement);
    expect(secondary.parentElement?.style.flexDirection).toBe("column");
    expect(primary.className).toContain("textOverflow");
    expect(secondary.className).toContain("textOverflow");
    expect(primary.style.fontSize).toBe("10px");
  });

  it("measures the two rows in a column with their intrinsic widths, without duplicate test IDs", () => {
    const view = render(
      <WorkspaceTabTitle label="combined" titleLines={titleLines} labelStyle={{}} measurement />,
    );
    const primary = view.getByText(titleLines.primaryLabel);
    const secondary = view.getByText(titleLines.secondaryLabel);
    expect(primary.parentElement?.parentElement).toBe(secondary.parentElement);
    expect(secondary.parentElement?.style.flexDirection).toBe("column");
    expect(secondary.parentElement?.style.alignItems).toBe("flex-start");
    expect(primary.style.flexShrink).toBe("0");
    expect(secondary.style.flexShrink).toBe("0");
    expect(view.queryByTestId("agent-tab-title-line-primary")).toBeNull();
  });

  it("only enables two rows for ready built-in conversation tabs", () => {
    for (const kind of ["agent", "provider_subagent"] as const) {
      expect(resolveWorkspaceTabTitleLines({ kind, titleState: "ready", titleLines })).toBe(
        titleLines,
      );
      expect(
        resolveWorkspaceTabTitleLines({ kind, titleState: "loading", titleLines }),
      ).toBeUndefined();
    }
    for (const kind of ["terminal", "file", "plugin"] as const) {
      expect(
        resolveWorkspaceTabTitleLines({ kind, titleState: "ready", titleLines }),
      ).toBeUndefined();
    }
  });

  it("invalidates a measurement when line boundaries change but the legacy label stays identical", () => {
    expect(
      workspaceTabTitleSignature("a-b-c", { primaryLabel: "a-b", secondaryLabel: "c" }),
    ).not.toBe(workspaceTabTitleSignature("a-b-c", { primaryLabel: "a", secondaryLabel: "b-c" }));
    expect(workspaceTabTitleSignature("a-b", { primaryLabel: "a", secondaryLabel: "b" })).not.toBe(
      workspaceTabTitleSignature("a-b", undefined),
    );
  });

  it("updates only elapsed text across second and minute boundaries and shares its clock", () => {
    vi.useFakeTimers();
    const completedAt = new Date("2026-10-26T00:00:00Z").getTime();
    vi.setSystemTime(completedAt + 5000);
    const lines = { ...titleLines, completedAt };
    const view = render(
      <>
        <WorkspaceTabTitle label="one" titleLines={lines} labelStyle={{}} />
        <WorkspaceTabTitle label="two" titleLines={lines} labelStyle={{}} />
      </>,
    );
    expect(view.getAllByTestId("agent-tab-completion-age").map((node) => node.textContent)).toEqual(
      ["5s", "5s"],
    );
    expect(activeRelativeTimeTickerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(55_000));
    expect(view.getAllByTestId("agent-tab-completion-age").map((node) => node.textContent)).toEqual(
      ["1m", "1m"],
    );
    expect(activeRelativeTimeTickerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(24 * 60_000));
    expect(view.getAllByTestId("agent-tab-completion-age")[0].textContent).toBe("25m");
    view.unmount();
    expect(activeRelativeTimeTickerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("reserves badge width during measurement without starting a clock", () => {
    const view = render(
      <WorkspaceTabTitle
        label="one"
        titleLines={{ ...titleLines, completedAt: Date.now() }}
        labelStyle={{}}
        measurement
      />,
    );
    expect(view.queryByTestId("agent-tab-completion-age")).toBeNull();
    expect(activeRelativeTimeTickerCount()).toBe(0);
    expect(view.getByText("00m").style.width).toBe("30px");
  });
});
