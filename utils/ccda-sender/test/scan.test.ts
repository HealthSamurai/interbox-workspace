import { expect, test, describe } from "bun:test";
import { XmlCursor, decodeEntities, localName, readTextContent, skipElement, type Token } from "../src/xml/scan.ts";

const tokens = (src: string): Token[] => {
  const cur = new XmlCursor(src);
  const out: Token[] = [];
  for (let t = cur.next(); t !== null; t = cur.next()) out.push(t);
  return out;
};

describe("localName", () => {
  test("strips a namespace prefix", () => {
    expect(localName("hl7:section")).toBe("section");
    expect(localName("section")).toBe("section");
  });
});

describe("decodeEntities", () => {
  test("resolves the five predefined entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(`a & b <c> "d" 'e'`);
  });

  test("resolves decimal and hex character references", () => {
    expect(decodeEntities("&#65;&#x42;&#x00e9;")).toBe("ABé");
  });

  test("leaves an unknown reference exactly as written", () => {
    // A vendor's unescaped ampersand is content. Dropping it would silently
    // change what the clinical document says.
    expect(decodeEntities("Smith &co; Jones &nbsp;")).toBe("Smith &co; Jones &nbsp;");
  });

  test("leaves an out-of-range or surrogate reference literal", () => {
    expect(decodeEntities("&#xD800;")).toBe("&#xD800;");
    expect(decodeEntities("&#1114112;")).toBe("&#1114112;");
  });

  test("returns the input untouched when there is nothing to decode", () => {
    expect(decodeEntities("plain text")).toBe("plain text");
  });
});

describe("XmlCursor", () => {
  test("reads elements, attributes and text", () => {
    const ts = tokens(`<a href="x" n='2'>hi</a>`);
    expect(ts.map((t) => t.kind)).toEqual(["open", "text", "close"]);
    const open = ts[0]!;
    if (open.kind !== "open") throw new Error("expected an open tag");
    expect(open.local).toBe("a");
    expect(open.attrs).toEqual({ href: "x", n: "2" });
    expect(open.selfClose).toBe(false);
  });

  test("marks a self-closing element and does not emit a close token", () => {
    const ts = tokens(`<br />`);
    expect(ts).toHaveLength(1);
    const t = ts[0]!;
    if (t.kind !== "open") throw new Error("expected an open tag");
    expect(t.selfClose).toBe(true);
  });

  test("handles a valueless attribute", () => {
    const ts = tokens(`<td nowrap>x</td>`);
    const t = ts[0]!;
    if (t.kind !== "open") throw new Error("expected an open tag");
    expect(t.attrs).toEqual({ nowrap: "" });
  });

  test("decodes entities inside attribute values", () => {
    const ts = tokens(`<x title="a &amp; b" />`);
    const t = ts[0]!;
    if (t.kind !== "open") throw new Error("expected an open tag");
    expect(t.attrs.title).toBe("a & b");
  });

  test("skips comments and processing instructions", () => {
    const ts = tokens(`<?xml version="1.0"?><!-- note --><a/>`);
    expect(ts.map((t) => t.kind)).toEqual(["pi", "comment", "open"]);
  });

  test("reads a CDATA section as text", () => {
    const ts = tokens(`<a><![CDATA[<not markup>]]></a>`);
    const t = ts[1]!;
    if (t.kind !== "text") throw new Error("expected text");
    expect(t.raw).toBe("<not markup>");
  });

  test("keeps namespace prefixes on the raw name and strips them on local", () => {
    const t = tokens(`<hl7:section/>`)[0]!;
    if (t.kind !== "open") throw new Error("expected an open tag");
    expect(t.name).toBe("hl7:section");
    expect(t.local).toBe("section");
  });

  test("token offsets slice back to the original markup", () => {
    const src = `<a><b>x</b></a>`;
    const b = tokens(src)[1]!;
    expect(src.slice(b.start, b.end)).toBe("<b>");
  });

  test("always advances on malformed markup", () => {
    // `5 < 6` in unescaped content must not put the cursor in a loop.
    const ts = tokens(`<a>5 < 6</a>`);
    expect(ts.at(-1)!.kind).toBe("close");
  });

  test("terminates on an unterminated tag", () => {
    expect(tokens(`<a><b attr="unclosed`).length).toBeGreaterThan(0);
  });
});

describe("readTextContent", () => {
  test("flattens child elements into one string", () => {
    const cur = new XmlCursor(`<name><given>Ada</given> <family>Lovelace</family></name>`);
    cur.next();
    expect(readTextContent(cur, "name")).toBe("Ada Lovelace");
  });

  test("stops at the matching close tag, not a nested one of the same name", () => {
    // Concatenation is verbatim — the reader adds no separators of its own, so
    // the only spaces in the result are the ones the document actually has.
    const cur = new XmlCursor(`<td>a<td>b</td>c</td>tail`);
    cur.next();
    expect(readTextContent(cur, "td")).toBe("abc");
  });

  test("collapses whitespace", () => {
    const cur = new XmlCursor("<t>\n   a\n\n   b   </t>");
    cur.next();
    expect(readTextContent(cur, "t")).toBe("a b");
  });
});

describe("skipElement", () => {
  test("leaves the cursor after the element's close tag", () => {
    const cur = new XmlCursor(`<a><b><b/></b></a><next/>`);
    cur.next();
    cur.next();
    skipElement(cur, "b");
    const t = cur.next();
    if (t?.kind !== "close") throw new Error("expected </a>");
    expect(t.local).toBe("a");
  });
});
