// @vitest-environment jsdom

import React from "react";
import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetainedPanelActivity } from "@/components/retained-panel";
import type { StreamItem } from "@/types/stream";
import { createStreamPresentation } from "./presentation";
import {
  HIDDEN_HISTORY_RELEASE_DELAY_MS,
  MAX_HIDDEN_STREAM_ITEMS,
  type ReleasableStreamHistory,
  useReleaseHiddenStreamHistory,
  useRetainedValue,
  useStreamPresentationLive,
} from "./presentation-liveness";

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

describe("hidden stream history release", () => {
  interface ReleaseProps {
    live: boolean;
    atLiveEdge: boolean;
    itemCount: number;
    history: ReleasableStreamHistory | null;
  }

  function createHistory(onRelease: () => boolean | Promise<boolean> = () => true) {
    const holds: string[] = [];
    const history: ReleasableStreamHistory & { release: ReturnType<typeof vi.fn> } = {
      retain: () => {
        holds.push("retain");
        return () => holds.push("let go");
      },
      release: vi.fn(async () => onRelease()),
    };
    return { history, holds };
  }

  function renderRelease(initial: ReleaseProps) {
    return renderHook((props: ReleaseProps) => useReleaseHiddenStreamHistory(props), {
      initialProps: initial,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases a long timeline once it stayed hidden at the live edge for the delay", async () => {
    const { history } = createHistory();
    const long = MAX_HIDDEN_STREAM_ITEMS + 1;
    const { result, rerender } = renderRelease({
      live: true,
      atLiveEdge: true,
      itemCount: long,
      history,
    });

    rerender({ live: false, atLiveEdge: true, itemCount: long, history });
    act(() => vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS - 1));
    expect(history.release).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(1));
    expect(history.release).toHaveBeenCalledOnce();
    expect(result.current).toBe(1);

    rerender({ live: false, atLiveEdge: true, itemCount: 40, history });
    act(() => vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS));
    expect(history.release).toHaveBeenCalledOnce();
  });

  it("keeps the rows of a stream shown again within the delay", () => {
    const { history } = createHistory();
    const long = MAX_HIDDEN_STREAM_ITEMS * 3;
    const { rerender } = renderRelease({ live: true, atLiveEdge: true, itemCount: long, history });

    for (let away = 0; away < 3; away += 1) {
      rerender({ live: false, atLiveEdge: true, itemCount: long, history });
      act(() => vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS - 1));
      rerender({ live: true, atLiveEdge: true, itemCount: long, history });
    }
    act(() => vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS));

    expect(history.release).not.toHaveBeenCalled();
  });

  it("keeps the rows of a reader who scrolled away from the live edge or a short timeline", () => {
    const { history } = createHistory();
    const { result, rerender } = renderRelease({
      live: false,
      atLiveEdge: false,
      itemCount: MAX_HIDDEN_STREAM_ITEMS * 3,
      history,
    });
    act(() => vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS));
    rerender({ live: false, atLiveEdge: true, itemCount: MAX_HIDDEN_STREAM_ITEMS, history });
    act(() => vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS));
    rerender({
      live: false,
      atLiveEdge: true,
      itemCount: MAX_HIDDEN_STREAM_ITEMS * 3,
      history: null,
    });
    act(() => vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS));

    expect(history.release).not.toHaveBeenCalled();
    expect(result.current).toBe(0);
  });

  it("leaves the view mounted when the release did not replace the rows", async () => {
    const { history } = createHistory(() => false);
    const long = MAX_HIDDEN_STREAM_ITEMS + 1;
    const { result } = renderRelease({ live: false, atLiveEdge: true, itemCount: long, history });

    await act(async () => vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS));

    expect(history.release).toHaveBeenCalledOnce();
    expect(result.current).toBe(0);
  });

  it("leaves a view shown again before the release settles mounted", async () => {
    let settle!: (replaced: boolean) => void;
    const { history } = createHistory(() => new Promise<boolean>((resolve) => (settle = resolve)));
    const long = MAX_HIDDEN_STREAM_ITEMS + 1;
    const { result, rerender } = renderRelease({
      live: false,
      atLiveEdge: true,
      itemCount: long,
      history,
    });
    act(() => vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS));
    expect(history.release).toHaveBeenCalledOnce();

    rerender({ live: true, atLiveEdge: true, itemCount: long, history });
    await act(async () => settle(true));

    expect(result.current).toBe(0);
  });

  it("retains the rows while the stream is shown and lets go of them when it is hidden", () => {
    const { history, holds } = createHistory();
    const { rerender, unmount } = renderRelease({
      live: true,
      atLiveEdge: true,
      itemCount: 10,
      history,
    });
    expect(holds).toEqual(["retain"]);

    rerender({ live: false, atLiveEdge: true, itemCount: 10, history });
    expect(holds).toEqual(["retain", "let go"]);

    rerender({ live: true, atLiveEdge: true, itemCount: 10, history });
    unmount();
    expect(holds).toEqual(["retain", "let go", "retain", "let go"]);
  });

  it("lets a frozen view drop its rows when the applied page re-renders it before the release settles", async () => {
    // The session store as the app has it: an external store whose change re-renders the
    // view on its own, outside any act scope, before the release promise settles.
    const long = Array.from({ length: MAX_HIDDEN_STREAM_ITEMS + 1 }, (_, index) =>
      toolCall(`row-${index}`, "log"),
    );
    const latest = long.slice(-40);
    let rows = long;
    const listeners = new Set<() => void>();
    const store = {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      read: () => rows,
    };
    const { history } = createHistory(() => {
      rows = latest;
      for (const listener of listeners) listener();
      return true;
    });
    let shown: StreamItem[] = [];
    function FrozenBody({ tail, live }: { tail: StreamItem[]; live: boolean }) {
      shown = useRetainedValue(tail, live);
      return null;
    }
    // As AgentStreamView does: the release counter mounts the frozen body again.
    function FrozenStream({ live }: { live: boolean }) {
      const tail = React.useSyncExternalStore(store.subscribe, store.read);
      const releases = useReleaseHiddenStreamHistory({
        live,
        atLiveEdge: true,
        itemCount: tail.length,
        history,
      });
      return <FrozenBody key={releases} tail={tail} live={live} />;
    }
    const { rerender } = render(<FrozenStream live />);
    rerender(<FrozenStream live={false} />);
    expect(shown).toBe(long);

    const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      vi.advanceTimersByTime(HIDDEN_HISTORY_RELEASE_DELAY_MS);
      for (let turn = 0; turn < 5; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
    }

    expect(history.release).toHaveBeenCalledOnce();
    expect(store.read()).toBe(latest);
    expect(shown).toBe(latest);
  });
});
