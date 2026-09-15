/**
 * A cursor over XML markup.
 *
 * The corpus this tool is pointed at runs from 3 KB to 12 MB per document, so
 * nothing here builds a token array or a tree: callers pull one token at a time
 * and stop as soon as they have what they came for. Header extraction reads a
 * few hundred tokens off the front of a 12 MB file and returns.
 *
 * The grammar covered is the one C-CDA actually uses — elements, attributes,
 * text, comments, processing instructions, and the five predefined entities
 * plus numeric character references. There is no DTD support and no CDATA
 * handling beyond skipping the section intact, because neither appears in a
 * conformant C-CDA and inventing coverage for them would be untested code.
 */

export type Token =
  | { kind: "open"; name: string; local: string; selfClose: boolean; attrs: Attrs; start: number; end: number }
  | { kind: "close"; name: string; local: string; start: number; end: number }
  | { kind: "text"; raw: string; start: number; end: number }
  | { kind: "comment"; start: number; end: number }
  | { kind: "pi"; start: number; end: number };

export type Attrs = Readonly<Record<string, string>>;

const EMPTY: Attrs = Object.freeze({});

/** Element name without its namespace prefix: `hl7:section` → `section`. */
export const localName = (name: string): string => {
  const i = name.indexOf(":");
  return i === -1 ? name : name.slice(i + 1);
};

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
});

/**
 * Resolve entity references in character data.
 *
 * An unrecognized reference is left exactly as written rather than dropped: in a
 * clinical narrative a literal `&` that a vendor failed to escape is content,
 * and silently eating it changes what the document says.
 */
export function decodeEntities(raw: string): string {
  if (raw.indexOf("&") === -1) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ref: string) => {
    if (ref.charCodeAt(0) === 35 /* # */) {
      const code = ref[1] === "x" || ref[1] === "X"
        ? Number.parseInt(ref.slice(2), 16)
        : Number.parseInt(ref.slice(1), 10);
      // Lone surrogates and out-of-range values would produce broken text; a
      // malformed reference stays literal for the same reason as an unknown one.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[ref] ?? whole;
  });
}

const isNameStart = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 58 || c > 127;

const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;

export class XmlCursor {
  readonly src: string;
  private pos = 0;

  constructor(src: string) {
    this.src = src;
  }

  /** Byte offset of the next token, for callers that slice the source directly. */
  get offset(): number {
    return this.pos;
  }

  /** The next token, or `null` at end of input. */
  next(): Token | null {
    const { src } = this;
    if (this.pos >= src.length) return null;
    const start = this.pos;

    if (src.charCodeAt(start) !== 60 /* < */) {
      // Character data runs to the next `<`, or to the end of the document.
      const lt = src.indexOf("<", start);
      const end = lt === -1 ? src.length : lt;
      this.pos = end;
      return { kind: "text", raw: src.slice(start, end), start, end };
    }

    if (src.startsWith("<!--", start)) {
      const close = src.indexOf("-->", start + 4);
      const end = close === -1 ? src.length : close + 3;
      this.pos = end;
      return { kind: "comment", start, end };
    }

    if (src.startsWith("<![CDATA[", start)) {
      const close = src.indexOf("]]>", start + 9);
      const end = close === -1 ? src.length : close + 3;
      this.pos = end;
      return { kind: "text", raw: src.slice(start + 9, close === -1 ? src.length : close), start, end };
    }

    if (src.startsWith("<?", start) || src.startsWith("<!", start)) {
      const close = src.indexOf(">", start);
      const end = close === -1 ? src.length : close + 1;
      this.pos = end;
      return { kind: "pi", start, end };
    }

    if (src.startsWith("</", start)) {
      let i = start + 2;
      while (i < src.length && !isSpace(src.charCodeAt(i)) && src.charCodeAt(i) !== 62) i += 1;
      const name = src.slice(start + 2, i);
      const close = src.indexOf(">", i);
      const end = close === -1 ? src.length : close + 1;
      this.pos = end;
      return { kind: "close", name, local: localName(name), start, end };
    }

    if (!isNameStart(src.charCodeAt(start + 1))) {
      // A bare `<` that starts nothing — treat the character as content so the
      // cursor always advances and a malformed document cannot spin the caller.
      this.pos = start + 1;
      return { kind: "text", raw: "<", start, end: start + 1 };
    }

    return this.readOpenTag(start);
  }

  private readOpenTag(start: number): Token {
    const { src } = this;
    let i = start + 1;
    while (i < src.length && !isSpace(src.charCodeAt(i)) && src.charCodeAt(i) !== 62 && src.charCodeAt(i) !== 47) i += 1;
    const name = src.slice(start + 1, i);

    let attrs: Record<string, string> | null = null;
    let selfClose = false;

    for (;;) {
      while (i < src.length && isSpace(src.charCodeAt(i))) i += 1;
      if (i >= src.length) break;
      const c = src.charCodeAt(i);
      if (c === 62 /* > */) { i += 1; break; }
      if (c === 47 /* / */) { selfClose = true; i += 1; continue; }

      const nameStart = i;
      while (i < src.length) {
        const a = src.charCodeAt(i);
        if (isSpace(a) || a === 61 || a === 62 || a === 47) break;
        i += 1;
      }
      const attrName = src.slice(nameStart, i);
      if (attrName === "") { i += 1; continue; }

      while (i < src.length && isSpace(src.charCodeAt(i))) i += 1;
      let value = "";
      if (src.charCodeAt(i) === 61 /* = */) {
        i += 1;
        while (i < src.length && isSpace(src.charCodeAt(i))) i += 1;
        const q = src.charCodeAt(i);
        if (q === 34 || q === 39) {
          const close = src.indexOf(String.fromCharCode(q), i + 1);
          const end = close === -1 ? src.length : close;
          value = decodeEntities(src.slice(i + 1, end));
          i = end + 1;
        } else {
          const vStart = i;
          while (i < src.length && !isSpace(src.charCodeAt(i)) && src.charCodeAt(i) !== 62) i += 1;
          value = decodeEntities(src.slice(vStart, i));
        }
      }
      (attrs ??= {})[attrName] = value;
    }

    this.pos = i;
    return { kind: "open", name, local: localName(name), selfClose, attrs: attrs ?? EMPTY, start, end: i };
  }
}

/**
 * Read the character data of the element the cursor has just opened.
 *
 * Child elements contribute their text and nothing else, which is what every
 * caller here wants: `<name><given>Ada</given> <family>Lovelace</family></name>`
 * reads as `Ada Lovelace`.
 */
export function readTextContent(cur: XmlCursor, elementName: string): string {
  let depth = 1;
  let out = "";
  for (let t = cur.next(); t !== null; t = cur.next()) {
    if (t.kind === "text") out += decodeEntities(t.raw);
    else if (t.kind === "open" && !t.selfClose && t.local === elementName) depth += 1;
    else if (t.kind === "close" && t.local === elementName) {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Advance past the element the cursor has just opened, ignoring its content. */
export function skipElement(cur: XmlCursor, elementName: string): void {
  let depth = 1;
  for (let t = cur.next(); t !== null; t = cur.next()) {
    if (t.kind === "open" && !t.selfClose && t.local === elementName) depth += 1;
    else if (t.kind === "close" && t.local === elementName && --depth === 0) return;
  }
}
