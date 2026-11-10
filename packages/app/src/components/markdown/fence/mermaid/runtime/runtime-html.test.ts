import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { mermaidRuntimeHtml } from "./html.gen";
import { MermaidRuntimeRequestDriver } from "./request-driver";

describe("Mermaid runtime document", () => {
  it("ships a closed network policy", () => {
    expect(mermaidRuntimeHtml).toContain("default-src 'none'");
    expect(mermaidRuntimeHtml).toContain("connect-src 'none'");
    expect(mermaidRuntimeHtml).toContain("img-src data: blob:");
    expect(mermaidRuntimeHtml).toContain("font-src 'none'");
    expect(mermaidRuntimeHtml).toContain("frame-src 'none'");
  });

  it("loads the large runtime document only when an iframe is rendered", () => {
    const source = ts.transpileModule(
      readFileSync(new URL("../iframe-runtime.web.tsx", import.meta.url), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText;
    let runtimeLoads = 0;
    let runtimeLoaded = false;
    const exports: Record<string, unknown> = {};
    const context = createContext({
      exports,
      require(id: string) {
        if (id === "react") {
          return {
            useRef: () => ({ current: null }),
            useCallback: (callback: unknown) => callback,
            useEffect: () => {},
          };
        }
        if (id === "react/jsx-runtime") {
          return { jsx: (type: string, props: unknown) => ({ type, props }) };
        }
        if (id === "./runtime/messages") return {};
        if (id === "./runtime/request-driver") {
          return { MermaidRuntimeRequestDriver };
        }
        if (id === "./runtime/html.gen") {
          if (!runtimeLoaded) runtimeLoads++;
          runtimeLoaded = true;
          return { mermaidRuntimeHtml };
        }
        throw new Error(`Unexpected iframe dependency: ${id}`);
      },
    });
    runInContext(source, context);
    expect(runtimeLoads).toBe(0);

    const render = exports.MermaidIframeRuntime as (props: {
      request: null;
      onRendered: () => void;
      onRenderFailed: () => void;
    }) => { type: string; props: { srcDoc: string; sandbox: string } };
    const props = { request: null, onRendered() {}, onRenderFailed() {} };
    const frame = render(props);
    expect(frame.type).toBe("iframe");
    expect(frame.props.srcDoc).toBe(mermaidRuntimeHtml);
    expect(frame.props.sandbox).toBe("allow-scripts");
    expect(runtimeLoads).toBe(1);
    render(props);
    expect(runtimeLoads).toBe(1);
  });
});
