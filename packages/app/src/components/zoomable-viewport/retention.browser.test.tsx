import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RetainedPanel } from "../retained-panel";
import { ZoomableViewport } from "./index.web";

vi.mock("./toolbar", () => ({
  ViewportToolbar: function TestToolbar({ onZoomIn }: { onZoomIn(): void }) {
    return (
      <button type="button" onClick={onZoomIn}>
        Zoom in
      </button>
    );
  },
}));

const contentSize = { width: 1000, height: 500 };

function Preview({ active }: { active: boolean }) {
  return (
    <RetainedPanel active={active}>
      <ZoomableViewport contentSize={contentSize} testID="preview">
        <span>Image preview</span>
      </ZoomableViewport>
    </RetainedPanel>
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

it("keeps zoom through retained hide and the first returned frames, then refits a real resize", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:800px;height:500px";
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<Preview active />));
    const canvas = host.querySelector('[data-testid="preview-canvas"]');
    const content = canvas?.firstElementChild;
    const zoomButton = host.querySelector("button");
    if (!(canvas instanceof HTMLElement) || !(content instanceof HTMLElement) || !zoomButton)
      throw Error("Preview fixture did not mount");
    await vi.waitFor(() => expect(content.getBoundingClientRect().width).toBeGreaterThan(0));
    act(() => zoomButton.click());
    expect(content.style.transform).toContain("scale(1.25)");
    const zoomed = content.style.transform;

    act(() => root.render(<Preview active={false} />));
    for (let frame = 0; frame < 3; frame++) await nextFrame();
    expect(canvas.getBoundingClientRect().width).toBe(0);
    expect(content.style.transform).toBe(zoomed);

    act(() => root.render(<Preview active />));
    const returnedTransforms: string[] = [];
    for (let frame = 0; frame < 3; frame++) {
      await nextFrame();
      returnedTransforms.push(content.style.transform);
    }
    expect(returnedTransforms).toEqual([zoomed, zoomed, zoomed]);
    expect(canvas.firstElementChild).toBe(content);

    host.style.width = "600px";
    await vi.waitFor(() => expect(content.style.transform).toContain("scale(1)"));
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
