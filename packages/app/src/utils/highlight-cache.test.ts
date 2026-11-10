import { describe, expect, it } from "vitest";
import {
  extensionFromPath,
  highlightToKeyedLines,
  MAX_HIGHLIGHT_CHARS,
  tokenizeToLines,
} from "./highlight-cache";

describe("extensionFromPath", () => {
  it("extracts a lowercased extension regardless of absolute/relative path", () => {
    expect(extensionFromPath("/repo/src/Index.TS")).toBe("ts");
    expect(extensionFromPath("src/index.ts")).toBe("ts");
    expect(extensionFromPath("a.b/c.tsx")).toBe("tsx");
  });

  it("returns null for paths without a usable extension", () => {
    expect(extensionFromPath(null)).toBeNull();
    expect(extensionFromPath(undefined)).toBeNull();
    expect(extensionFromPath("Makefile")).toBeNull();
    expect(extensionFromPath(".gitignore")).toBeNull();
    expect(extensionFromPath("trailingdot.")).toBeNull();
  });
});

describe("tokenizeToLines", () => {
  it("returns one token array per line for a supported language", () => {
    const lines = tokenizeToLines("const a = 1;\nconst b = 2;", "ts");
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(2);
    expect(lines?.[0].some((token) => token.style === "keyword")).toBe(true);
  });

  it("returns null when there is no extension", () => {
    expect(tokenizeToLines("whatever", null)).toBeNull();
  });

  it("falls back to style-less per-line tokens for an unknown extension", () => {
    const lines = tokenizeToLines("line one\nline two", "unknownext");
    expect(lines).toHaveLength(2);
    expect(lines?.[0]).toEqual([{ text: "line one", style: null }]);
  });

  it("returns null above the size cap so callers fall back to plain text", () => {
    const huge = "x".repeat(MAX_HIGHLIGHT_CHARS + 1);
    expect(tokenizeToLines(huge, "ts")).toBeNull();
  });

  it("serves a cached result on repeat calls (identity-stable)", () => {
    const first = tokenizeToLines("const cached = true;", "ts");
    const second = tokenizeToLines("const cached = true;", "ts");
    expect(first).toBe(second);
  });

  it("evicts older token-heavy results while retaining recently used small results", () => {
    const denseCode = (index: number) =>
      `// dense cache fixture ${index}\n` +
      "const value = 123; function f(x) { return x + 1; }\n".repeat(1900);
    const firstCode = denseCode(0);
    const first = tokenizeToLines(firstCode, "ts");
    const smallCode = "const recentlyUsedSmallCacheEntry = true;";
    const small = tokenizeToLines(smallCode, "ts");

    for (let index = 1; index <= 4; index += 1) {
      expect(tokenizeToLines(smallCode, "ts")).toBe(small);
      expect(tokenizeToLines(denseCode(index), "ts")).not.toBeNull();
    }

    expect(tokenizeToLines(smallCode, "ts")).toBe(small);
    const rebuilt = tokenizeToLines(firstCode, "ts");
    expect(rebuilt).not.toBe(first);
    const rebuiltText: string[] = [];
    for (const line of rebuilt ?? []) {
      rebuiltText.push(line.map((token) => token.text).join(""));
    }
    expect(rebuiltText.join("\n")).toBe(firstCode);
    expect(rebuilt?.[1].some((token) => token.style === "keyword")).toBe(true);
  });
});

describe("highlightToKeyedLines", () => {
  it("produces stable keys for lines and tokens", () => {
    const keyed = highlightToKeyedLines("const a = 1;", "ts");
    expect(keyed?.[0].key).toBe("line-0");
    expect(keyed?.[0].tokens[0].key).toBe("0-0");
  });

  it("returns null when highlighting is unavailable", () => {
    expect(highlightToKeyedLines("text", null)).toBeNull();
  });
});
