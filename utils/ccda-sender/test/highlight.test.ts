import { expect, test, describe } from "bun:test";
import { highlightXml, takeLines, highlightSlice, formatXml, isMinified } from "../src/cda/highlight.ts";

/** The rendered text with every span removed — what a reader actually sees. */
const plain = (html: string): string =>
  html.replace(/<\/?span[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");

describe("highlightXml", () => {
  test("reproduces the source exactly once the spans are stripped", () => {
    const src = `<?xml version="1.0"?>\n<a b="1" c='2'>\n  text &amp; more\n  <!-- note -->\n  <d/>\n</a>`;
    expect(plain(highlightXml(src))).toBe(src);
  });

  test("keeps every line break, so a line gutter stays aligned", () => {
    const src = `<a>\n<b>\n</b>\n</a>`;
    const countNewlines = (s: string) => (s.match(/\n/g) ?? []).length;
    expect(countNewlines(highlightXml(src))).toBe(countNewlines(src));
  });

  test("keeps a line break that falls inside a tag", () => {
    const src = `<a\n   b="1"\n   c="2"/>`;
    expect(plain(highlightXml(src))).toBe(src);
  });

  test("labels element names, attribute names and attribute values apart", () => {
    const html = highlightXml(`<code displayName="Encounters"/>`);
    expect(html).toContain(`<span class="xe">code</span>`);
    expect(html).toContain(`<span class="xa">displayName</span>`);
    expect(html).toContain(`<span class="xv">&quot;Encounters&quot;</span>`);
  });

  test("labels comments and declarations", () => {
    expect(highlightXml(`<!-- hi -->`)).toContain(`class="xc"`);
    expect(highlightXml(`<?xml version="1.0"?>`)).toContain(`class="xd"`);
  });

  test("escapes markup that appears in text content", () => {
    const html = highlightXml(`<a>5 &lt; 6</a>`);
    expect(html).not.toMatch(/<(?!\/?span)/);
  });

  test("cannot be used to inject markup through an attribute value", () => {
    const html = highlightXml(`<a t="<script>alert(1)</script>">x</a>`);
    expect(html).not.toContain("<script");
  });

  test("handles an empty document", () => {
    expect(highlightXml("")).toBe("");
  });
});

describe("takeLines", () => {
  test("keeps the whole document when it is shorter than the budget", () => {
    const r = takeLines("a\nb\nc", 10);
    expect(r.text).toBe("a\nb\nc");
    expect(r.totalLines).toBe(3);
    expect(r.shownLines).toBe(3);
  });

  test("cuts at the budget and still reports the true total", () => {
    const src = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const r = takeLines(src, 10);
    expect(r.shownLines).toBe(10);
    expect(r.totalLines).toBe(100);
    expect(r.text.split("\n")).toHaveLength(10);
  });

  test("counts a trailing newline as ending the last line, not starting a new one", () => {
    expect(takeLines("a\nb\n", 10).totalLines).toBe(2);
  });

  test("reports nothing for an empty document", () => {
    expect(takeLines("", 10)).toEqual({ text: "", shownLines: 0, totalLines: 0 });
  });
});

describe("highlightSlice", () => {
  test("reports the size of what it did not render", () => {
    const src = Array.from({ length: 500 }, () => `<a>x</a>`).join("\n");
    const s = highlightSlice(src, 20);
    expect(s.shownLines).toBe(20);
    expect(s.totalLines).toBe(500);
    expect(s.totalChars).toBe(src.length);
  });
});

describe("isMinified", () => {
  test("recognises a document written as one long line", () => {
    expect(isMinified("x".repeat(500_000), 1)).toBe(true);
  });

  test("leaves an indented document alone", () => {
    const src = Array.from({ length: 2000 }, () => "<a>x</a>").join("\n");
    expect(isMinified(src, 2000)).toBe(false);
  });

  test("says no for an empty document", () => {
    expect(isMinified("", 0)).toBe(false);
  });
});

describe("formatXml", () => {
  test("puts each element on its own line and indents by depth", () => {
    const r = formatXml(`<a><b><c>x</c></b></a>`, 100);
    expect(r.text).toBe(`<a>\n  <b>\n    <c>x</c>\n  </b>\n</a>`);
    expect(r.lines).toBe(5);
    expect(r.complete).toBe(true);
  });

  test("keeps an element whose content is only text on one line", () => {
    expect(formatXml(`<title>Continuity of Care Document</title>`, 100).text)
      .toBe(`<title>Continuity of Care Document</title>`);
  });

  test("keeps attributes and self-closing tags as written", () => {
    expect(formatXml(`<a><id root="1.2" extension="X"/></a>`, 100).text)
      .toBe(`<a>\n  <id root="1.2" extension="X"/>\n</a>`);
  });

  test("stops at the line budget and says it is not done", () => {
    const src = `<root>${"<a>x</a>".repeat(500)}</root>`;
    const r = formatXml(src, 20);
    expect(r.lines).toBeLessThanOrEqual(20);
    expect(r.complete).toBe(false);
  });

  test("drops whitespace that was only there for indentation", () => {
    expect(formatXml(`<a>\n\n   <b>  y  </b>\n</a>`, 100).text).toBe(`<a>\n  <b>y</b>\n</a>`);
  });

  test("keeps a declaration and a comment on their own lines", () => {
    expect(formatXml(`<?xml version="1.0"?><!-- note --><a/>`, 100).text)
      .toBe(`<?xml version="1.0"?>\n<!-- note -->\n<a/>`);
  });
});

describe("highlightSlice on a minified document", () => {
  const oneLine = `<ClinicalDocument>${"<section><title>T</title><text>x</text></section>".repeat(400)}</ClinicalDocument>`;

  test("reformats it and says so", () => {
    const s = highlightSlice(oneLine, 40);
    expect(s.reformatted).toBe(true);
    expect(s.totalLines).toBe(1);
    expect(s.shownLines).toBeGreaterThan(1);
    expect(s.complete).toBe(false);
  });

  test("leaves it alone when the reader asks for the raw file", () => {
    const s = highlightSlice(oneLine, 40, true);
    expect(s.reformatted).toBe(false);
    expect(s.shownLines).toBe(1);
  });

  test("does not reformat a document that already has lines", () => {
    const src = Array.from({ length: 50 }, () => "<a>x</a>").join("\n");
    expect(highlightSlice(src, 400).reformatted).toBe(false);
  });
});
