/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LinkRendererProps } from "react-native-enriched-markdown";
import { getByRole, queryByTestId } from "@testing-library/dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantFileLinkResolverProvider } from "@/assistant-file-links";
import { WEB_RENDERERS } from "./renderers.web";

vi.mock("./fence/mermaid", () => ({ MermaidFence: () => null }));
vi.mock("@/components/highlighted-code-block", () => ({ HighlightedCodeBlock: () => null }));

interface MountedLink {
  root: Root;
  container: HTMLDivElement;
  queryClient: QueryClient;
}
const mounted: MountedLink[] = [];

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
    entry.queryClient.clear();
  }
  vi.unstubAllGlobals();
});

function mountLink(linkProps: Omit<LinkRendererProps, "children">) {
  const Link = WEB_RENDERERS.link;
  if (!Link) throw new Error("Markdown link renderer is missing");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const queryClient = new QueryClient();
  const download = vi.fn();
  const open = vi.fn();
  mounted.push({ root, container, queryClient });
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <AssistantFileLinkResolverProvider
          serverId="host"
          workspaceRoot="/repo"
          onOpenWorkspaceFile={open}
          onDownloadWorkspaceFile={download}
        >
          <p>
            File: <Link {...linkProps}>Report</Link>
          </p>
        </AssistantFileLinkResolverProvider>
      </QueryClientProvider>,
    ),
  );
  return { container, download, open, link: getByRole(container, "link", { name: "Report" }) };
}

it("downloads a file from its right-click menu without opening the file or breaking prose", async () => {
  const href = "/repo/reports/report.csv:12";
  const { container, link, download, open } = mountLink({
    link: { url: href, sourceType: "markdown" },
    anchorProps: { href },
  });
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 120,
    clientY: 80,
  });
  act(() => {
    link.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  expect(container.querySelectorAll("p div")).toHaveLength(0);
  const item = queryByTestId(document.body, "assistant-file-link-download");
  if (!item) throw new Error("File download menu did not open");
  act(() => item.click());
  await expect
    .poll(() => download.mock.calls)
    .toEqual([[{ fileName: "report.csv", path: "/repo/reports/report.csv" }]]);
  expect(open).not.toHaveBeenCalled();
  expect(queryByTestId(document.body, "assistant-file-link-download")).toBeNull();
});

it("preserves the browser context menu for external links", () => {
  const href = "https://example.com/article";
  const { link, download } = mountLink({
    link: { url: href, sourceType: "markdown" },
    anchorProps: { href },
  });
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  act(() => {
    link.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(false);
  expect(queryByTestId(document.body, "assistant-file-link-download")).toBeNull();
  expect(download).not.toHaveBeenCalled();
});
