// @vitest-environment jsdom

import React from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RetainedPanelActivity } from "@/components/retained-panel";
import type { StreamItem } from "@/types/stream";
import { createStreamPresentation } from "./presentation";
import { useRetainedValue, useStreamPresentationLive } from "./presentation-liveness";

let visibilityState: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", {
  configurable: true,
  get: () => visibilityState,
});

function setDocumentVisibility(next: DocumentVisibilityState): void {
  visibilityState = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

function toolCall(id: string, log: string): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date("2026-11-14T00:00:00.000Z"),
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: id,
        name: "Sub-agent",
        status: "running",
        error: null,
        detail: { type: "sub_agent", log },
      },
    },
  };
}

function useStreamTailPresentation(input: { tail: StreamItem[] }) {
  const [present] = React.useState(() => createStreamPresentation());
  const presentations = React.useRef(0);
  const live = useStreamPresentationLive();
  const tail = useRetainedValue(input.tail, live);
  const presentation = React.useMemo(() => {
    presentations.current += 1;
    return present({ tail, head: [], transform: undefined, level: "detailed", isTurnActive: true });
  }, [present, tail]);
  return { live, presentation, presentations: presentations.current };
}

function renderStream(initialTail: StreamItem[], panelActive = true) {
  return renderHook(({ tail }: { tail: StreamItem[] }) => useStreamTailPresentation({ tail }), {
    initialProps: { tail: initialTail },
    wrapper: ({ children }) => (
      <RetainedPanelActivity active={panelActive}>{children}</RetainedPanelActivity>
    ),
  });
}

afterEach(() => {
  act(() => setDocumentVisibility("visible"));
});

describe("stream presentation liveness", () => {
  it("stops reprojecting the timeline while the window is hidden", () => {
    const first = [toolCall("card", "line 1")];
    const { result, rerender } = renderStream(first);
    expect(result.current.live).toBe(true);
    expect(result.current.presentations).toBe(1);

    act(() => setDocumentVisibility("hidden"));
    expect(result.current.live).toBe(false);

    let tail = first;
    for (let index = 2; index <= 20; index += 1) {
      tail = [toolCall("card", `line ${index}`)];
      rerender({ tail });
    }

    expect(result.current.presentations).toBe(1);
    expect(result.current.presentation.tail).toEqual(first);
  });

  it("shows every row received while hidden, in order, once the window is visible again", () => {
    const opening = [toolCall("t1", "a")];
    const { result, rerender } = renderStream(opening);

    act(() => setDocumentVisibility("hidden"));
    const received: StreamItem[] = [...opening];
    for (let index = 2; index <= 5; index += 1) {
      received.push(toolCall(`t${index}`, String(index)));
      rerender({ tail: [...received] });
    }
    const latest = [...received.slice(0, -1), toolCall("t5", "5 updated")];
    rerender({ tail: latest });
    expect(result.current.presentation.tail.map((item) => item.id)).toEqual(["t1"]);

    act(() => setDocumentVisibility("visible"));

    expect(result.current.live).toBe(true);
    expect(result.current.presentations).toBe(2);
    expect(result.current.presentation.tail).toEqual(latest);
  });

  it("keeps an inactive tab slot frozen whatever the window visibility", () => {
    const first = [toolCall("card", "line 1")];
    const { result, rerender } = renderStream(first, false);
    rerender({ tail: [toolCall("card", "line 2")] });

    expect(result.current.live).toBe(false);
    expect(result.current.presentations).toBe(1);
    expect(result.current.presentation.tail).toEqual(first);
  });
});
