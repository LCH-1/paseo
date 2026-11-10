import { highlightCode, type HighlightToken } from "@getpaseo/highlight";

// Shared, theme-independent tokenization + cache for syntax highlighting.
// Used by markdown code blocks, file preview, and tool-call detail blocks
// (Edit diff / Write / Read). Colors are applied at render time, so the cache
// key is just (extension, code) and one entry serves both light and dark.

export interface KeyedToken {
  key: string;
  token: HighlightToken;
}

export interface KeyedLine {
  key: string;
  tokens: KeyedToken[];
}

// Above this, highlighting a whole document on the main thread risks a visible
// stall when a large Read/Write block is expanded. Callers fall back to plain
// monospace text. Generous enough to cover the vast majority of real blocks.
export const MAX_HIGHLIGHT_CHARS = 100_000;

class LRUCache<K, V> {
  private readonly map = new Map<K, { value: V; weight: number }>();
  private weight = 0;
  constructor(
    private readonly max: number,
    private readonly maxWeight: number,
  ) {}

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, weight: number): void {
    const previous = this.map.get(key);
    if (previous !== undefined) {
      this.map.delete(key);
      this.weight -= previous.weight;
    }
    if (weight > this.maxWeight) return;

    this.map.set(key, { value, weight });
    this.weight += weight;
    while (this.map.size > this.max || this.weight > this.maxWeight) {
      const oldest = this.map.entries().next();
      if (oldest.done) break;
      this.map.delete(oldest.value[0]);
      this.weight -= oldest.value[1].weight;
    }
  }
}

const MAX_TOKENIZATION_CACHE_BYTES = 8 * 1024 * 1024;
const tokenizationCache = new LRUCache<string, HighlightToken[][]>(
  200,
  MAX_TOKENIZATION_CACHE_BYTES,
);

function estimateTokenizationBytes(cacheKey: string, lines: HighlightToken[][]): number {
  // Account for the retained source key, token text, arrays and token objects.
  // Use estimated bytes rather than engine-specific object sizes: entry count
  // alone lets a few token-dense documents retain tens of MiB.
  let bytes = 64 + cacheKey.length * 2 + lines.length * 32;
  for (const line of lines) {
    for (const token of line) {
      bytes += 48 + token.text.length * 2;
    }
  }
  return bytes;
}

// Tokenize `code` to per-line tokens, cached. Returns null when the language is
// unsupported, the input is over the size cap, or parsing throws — callers then
// render plain text.
export function tokenizeToLines(code: string, ext: string | null): HighlightToken[][] | null {
  if (!ext) return null;
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  const cacheKey = `${ext}:${code}`;
  const cached = tokenizationCache.get(cacheKey);
  if (cached) return cached;
  let lines: HighlightToken[][];
  try {
    lines = highlightCode(code, `x.${ext}`);
  } catch {
    return null;
  }
  tokenizationCache.set(cacheKey, lines, estimateTokenizationBytes(cacheKey, lines));
  return lines;
}

function toKeyedLine(tokens: HighlightToken[], lineIndex: number): KeyedLine {
  return {
    key: `line-${lineIndex}`,
    tokens: tokens.map((token, tokenIndex) => ({
      key: `${lineIndex}-${tokenIndex}`,
      token,
    })),
  };
}

export function highlightToKeyedLines(code: string, ext: string | null): KeyedLine[] | null {
  const lines = tokenizeToLines(code, ext);
  return lines ? lines.map(toKeyedLine) : null;
}

// Extension for grammar selection from a file path. We only need the suffix —
// absolute vs relative paths are equivalent here.
export function extensionFromPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}
