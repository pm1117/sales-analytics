import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  contentHash,
  domainOf,
} from "../src/compliance/url-canonical";
import { chunkMarkdown } from "../src/embedding/chunker";
import { normalizeTo1536 } from "../src/embedding/normalize";
import { htmlToMarkdown, looksDynamic } from "../src/adapters/html-text";

describe("canonicalizeUrl", () => {
  it("normalizes scheme, www, tracking params, trailing slash, fragment", () => {
    expect(
      canonicalizeUrl(
        "http://www.Example.com/Path/?utm_source=x&b=2&a=1#frag",
      ),
    ).toBe("https://example.com/Path?a=1&b=2");
  });

  it("keeps root slash", () => {
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("extracts domain without www", () => {
    expect(domainOf("https://www.foo.co.jp/x")).toBe("foo.co.jp");
  });
});

describe("contentHash", () => {
  it("is stable across inline-whitespace and trailing-newline differences", () => {
    const a = contentHash("# Title\nHello   world\n\n");
    const b = contentHash("# Title\nHello world");
    expect(a.equals(b)).toBe(true);
  });
  it("differs on real content change", () => {
    expect(contentHash("a").equals(contentHash("b"))).toBe(false);
  });
});

describe("chunkMarkdown", () => {
  it("produces chunks split on H2/H3", () => {
    const md = `# Doc\n\nintro\n\n## A\n\n${"x ".repeat(600)}\n\n## B\n\nend`;
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.chunkIndex).toBe(0);
  });
});

describe("normalizeTo1536", () => {
  it("pads via projection when nativeDim < 1536", () => {
    const v = normalizeTo1536(Float32Array.from([1, 2, 3, 4]), 4);
    expect(v.length).toBe(1536);
  });
  it("truncates when nativeDim > 1536", () => {
    const big = new Float32Array(3072).fill(0.1);
    expect(normalizeTo1536(big, 3072).length).toBe(1536);
  });
  it("passes through at 1536", () => {
    const v = new Float32Array(1536).fill(0.5);
    expect(normalizeTo1536(v, 1536)).toBe(v);
  });
});

describe("htmlToMarkdown", () => {
  it("extracts title and strips scripts", () => {
    const { title, markdown } = htmlToMarkdown(
      "<html><head><title>T</title></head><body><script>evil()</script><h2>Head</h2><p>Body text</p></body></html>",
    );
    expect(title).toBe("T");
    expect(markdown).toContain("## Head");
    expect(markdown).toContain("Body text");
    expect(markdown).not.toContain("evil");
  });

  it("detects dynamic SPA shells", () => {
    expect(looksDynamic('<div id="__next"></div>', "")).toBe(true);
  });
});
