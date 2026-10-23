/** @vitest-environment jsdom */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveWorkspaceTabTitleLines,
  workspaceTabTitleSignature,
  WorkspaceTabTitle,
} from "./workspace-tab-title";

afterEach(cleanup);

const titleLines = { primaryLabel: "결제 프로젝트 🧩", secondaryLabel: "main" };

describe("workspace tab title", () => {
  it("renders independent ellipsized project and workspace rows", () => {
    const view = render(<WorkspaceTabTitle label="combined" titleLines={titleLines} labelStyle={{}} />);
    const primary = view.getByTestId("agent-tab-title-line-primary");
    const secondary = view.getByTestId("agent-tab-title-line-secondary");
    expect(primary.textContent).toBe(titleLines.primaryLabel);
    expect(secondary.textContent).toBe(titleLines.secondaryLabel);
    expect(primary.parentElement).toBe(secondary.parentElement);
    expect(primary.parentElement?.style.flexDirection).toBe("column");
    expect(primary.className).toContain("textOverflow");
    expect(secondary.className).toContain("textOverflow");
    expect(primary.style.fontSize).toBe("10px");
  });

  it("measures the two rows in a column with their intrinsic widths, without duplicate test IDs", () => {
    const view = render(<WorkspaceTabTitle label="combined" titleLines={titleLines} labelStyle={{}} measurement />);
    const primary = view.getByText(titleLines.primaryLabel);
    const secondary = view.getByText(titleLines.secondaryLabel);
    expect(primary.parentElement).toBe(secondary.parentElement);
    expect(primary.parentElement?.style.flexDirection).toBe("column");
    expect(primary.parentElement?.style.alignItems).toBe("flex-start");
    expect(primary.style.flexShrink).toBe("0");
    expect(secondary.style.flexShrink).toBe("0");
    expect(view.queryByTestId("agent-tab-title-line-primary")).toBeNull();
  });

  it("only enables two rows for ready built-in conversation tabs", () => {
    for (const kind of ["agent", "provider_subagent"] as const) {
      expect(resolveWorkspaceTabTitleLines({ kind, titleState: "ready", titleLines })).toBe(titleLines);
      expect(resolveWorkspaceTabTitleLines({ kind, titleState: "loading", titleLines })).toBeUndefined();
    }
    for (const kind of ["terminal", "file", "plugin"] as const) {
      expect(resolveWorkspaceTabTitleLines({ kind, titleState: "ready", titleLines })).toBeUndefined();
    }
  });

  it("invalidates a measurement when line boundaries change but the legacy label stays identical", () => {
    expect(workspaceTabTitleSignature("a-b-c", { primaryLabel: "a-b", secondaryLabel: "c" }))
      .not.toBe(workspaceTabTitleSignature("a-b-c", { primaryLabel: "a", secondaryLabel: "b-c" }));
    expect(workspaceTabTitleSignature("a-b", { primaryLabel: "a", secondaryLabel: "b" }))
      .not.toBe(workspaceTabTitleSignature("a-b", undefined));
  });
});
