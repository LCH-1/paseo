import { describe, expect, it } from "vitest";
import {
  explorerSidebarCloseButtonLayout,
  readRenderedContainerSize,
  resolveExplorerSidebarDockSizes,
  resolveExplorerSidebarWidth,
} from "@/components/explorer-sidebar-layout";

describe("Explorer sidebar layout", () => {
  it("preserves the previous dock measurement while a retained workspace is hidden", () => {
    const requestedWidth = 900;
    let containerWidth = 1200;
    expect(resolveExplorerSidebarWidth({ requestedWidth, containerWidth })).toBe(800);
    for (const hiddenSize of [
      { width: 0, height: 500 },
      { width: 1200, height: 0 },
      { width: 0, height: 0 },
    ]) {
      containerWidth =
        readRenderedContainerSize({ ...hiddenSize, direction: "horizontal" }) ?? containerWidth;
      expect(resolveExplorerSidebarWidth({ requestedWidth, containerWidth })).toBe(800);
      expect(resolveExplorerSidebarDockSizes({ requestedWidth, containerWidth })[1]).toBeCloseTo(
        2 / 3,
      );
    }
    containerWidth =
      readRenderedContainerSize({ width: 1520, height: 500, direction: "horizontal" }) ??
      containerWidth;
    expect(resolveExplorerSidebarWidth({ requestedWidth, containerWidth })).toBe(900);
  });

  it("keeps the sidebar width fixed when the workspace body changes size", () => {
    const narrow = resolveExplorerSidebarDockSizes({ requestedWidth: 320, containerWidth: 1200 });
    const wide = resolveExplorerSidebarDockSizes({ requestedWidth: 320, containerWidth: 1520 });

    expect(narrow[1] * 1200).toBeCloseTo(320);
    expect(wide[1] * 1520).toBeCloseTo(320);
  });

  it("accepts vertical split geometry only while both dimensions are rendered", () => {
    expect(readRenderedContainerSize({ width: 1200, height: 500, direction: "vertical" })).toBe(
      500,
    );
    expect(readRenderedContainerSize({ width: 0, height: 500, direction: "vertical" })).toBeNull();
    expect(readRenderedContainerSize({ width: 1200, height: 0, direction: "vertical" })).toBeNull();
  });

  it("has no fixed maximum while preserving room for the workspace body", () => {
    expect(resolveExplorerSidebarWidth({ requestedWidth: 100, containerWidth: 1200 })).toBe(240);
    expect(resolveExplorerSidebarWidth({ requestedWidth: 900, containerWidth: 1600 })).toBe(900);
    expect(resolveExplorerSidebarWidth({ requestedWidth: 900, containerWidth: 1200 })).toBe(800);
    expect(resolveExplorerSidebarWidth({ requestedWidth: 600, containerWidth: 750 })).toBe(350);
  });
});

describe("Explorer close action", () => {
  it("preserves the wide-native touch target and glyph rail", () => {
    const layout = explorerSidebarCloseButtonLayout(false);
    expect(layout.size).toBe(34);
    expect(layout.iconSize).toBe(18);
    expect(layout.size + layout.hitSlop * 2).toBe(50);
    expect(layout.trailingPadding + (layout.size - layout.iconSize) / 2).toBe(16);
  });

  it("keeps the compact close glyph on the pane rail", () => {
    const layout = explorerSidebarCloseButtonLayout(true);
    expect(layout.size).toBe(32);
    expect(layout.iconSize).toBe(18);
    expect(layout.trailingPadding + (layout.size - layout.iconSize) / 2).toBe(8);
  });
});
