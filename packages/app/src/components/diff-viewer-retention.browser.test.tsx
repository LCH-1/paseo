import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RetainedPanel } from "./retained-panel";
import { DiffViewer } from "./diff-viewer";
import type { DiffLine } from "@/utils/tool-call-parsers";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native-unistyles", async () => {
  const { darkTheme } = await import("@/styles/theme");
  return {
    StyleSheet: {
      create: (styles: unknown) => (typeof styles === "function" ? styles(darkTheme) : styles),
    },
  };
});

const lines: DiffLine[] = [
  { type: "add", content: "+x" },
  { type: "remove", content: "-y" },
];

function Preview({ active }: { active: boolean }) {
  return (
    <RetainedPanel active={active}>
      <DiffViewer diffLines={lines} fillAvailableHeight />
    </RetainedPanel>
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

it("keeps diff line geometry through retained hide and the first returned frames, then measures a real resize", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:800px;height:500px";
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<Preview active />));
    const surface = host.querySelector("[data-pmono]");
    const row = surface?.firstElementChild;
    if (!(surface instanceof HTMLElement) || !(row instanceof HTMLElement))
      throw Error("Diff fixture did not mount");
    await vi.waitFor(() => expect(surface.style.minWidth).toBe("800px"));
    const renderedWidth = surface.getBoundingClientRect().width;
    const renderedRowWidth = row.getBoundingClientRect().width;

    act(() => root.render(<Preview active={false} />));
    for (let frame = 0; frame < 4; frame++) await nextFrame();
    expect(surface.getBoundingClientRect().width).toBe(0);
    expect(surface.style.minWidth).toBe("800px");

    act(() => root.render(<Preview active />));
    const returnedWidths = [surface.getBoundingClientRect().width];
    const returnedRowWidths = [row.getBoundingClientRect().width];
    for (let frame = 0; frame < 3; frame++) {
      await nextFrame();
      returnedWidths.push(surface.getBoundingClientRect().width);
      returnedRowWidths.push(row.getBoundingClientRect().width);
    }
    expect(returnedWidths).toEqual(Array(4).fill(renderedWidth));
    expect(returnedRowWidths).toEqual(Array(4).fill(renderedRowWidth));
    expect(host.querySelector("[data-pmono]")).toBe(surface);

    host.style.width = "600px";
    await vi.waitFor(() => expect(surface.style.minWidth).toBe("600px"));
    expect(surface.getBoundingClientRect().width).toBe(600);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
