import React, { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RetainedPanel } from "./retained-panel";
import { readRenderedContainerSize, resolveExplorerSidebarWidth } from "./explorer-sidebar-layout";

const chrome = vi.hoisted(() => ({
  paneContentToolbarIconSize: () => 14,
  paneContentToolbarTrailingPadding: () => 0,
  smallIconButtonChromeFrameSize: () => 20,
}));
vi.mock("@/components/ui/pane-content-toolbar", () => chrome);
vi.mock("@/components/ui/icon-button-chrome", () => chrome);

function RetainedExplorer({ active }: { active: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const measured = readRenderedContainerSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
        direction: "horizontal",
      });
      if (measured !== null) setWidth((current) => (current === measured ? current : measured));
    });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  return (
    <RetainedPanel active={active}>
      <div
        ref={container}
        style={{ flex: 1, display: "flex" }}
        data-testid="measured-container"
        data-width={width}
      >
        <div style={{ flex: 1 }} />
        <div
          data-testid="explorer-dock"
          style={{
            width: resolveExplorerSidebarWidth({ requestedWidth: 900, containerWidth: width }),
          }}
        />
      </div>
    </RetainedPanel>
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

it("keeps the last rendered dock geometry through retained hide and the first returned frames", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:1200px;height:500px";
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<RetainedExplorer active />));
    const container = host.querySelector('[data-testid="measured-container"]');
    const dock = host.querySelector('[data-testid="explorer-dock"]');
    if (!(container instanceof HTMLElement) || !(dock instanceof HTMLElement))
      throw Error("Retained fixture did not mount");
    await vi.waitFor(() => expect(dock.getBoundingClientRect().width).toBe(800));
    act(() => root.render(<RetainedExplorer active={false} />));
    await nextFrame();
    await nextFrame();
    await nextFrame();
    expect(container.getBoundingClientRect().width).toBe(0);
    expect(container.getAttribute("data-width")).toBe("1200");
    act(() => root.render(<RetainedExplorer active />));
    const returnedWidths: number[] = [];
    for (let frame = 0; frame < 3; frame++) {
      await nextFrame();
      returnedWidths.push(dock.getBoundingClientRect().width);
    }
    expect(returnedWidths).toEqual([800, 800, 800]);
    expect(host.querySelector('[data-testid="measured-container"]')).toBe(container);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
