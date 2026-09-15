/**
 * The readable half of a C-CDA: section titles and their narrative blocks.
 *
 * Every CDA section carries a `<text>` block that the sending system rendered
 * for a human to read — the same content a clinician saw. It is markup in HL7's
 * own vocabulary, close enough to HTML to look familiar and different enough to
 * render wrong if handed to a browser as-is: `<paragraph>` and `<content>` have
 * no HTML meaning, so a raw dump collapses a formatted document into one run of
 * unstyled text.
 *
 * Translation is by allow-list, in both directions at once. Elements not on the
 * list are unwrapped rather than dropped, so unrecognized markup costs its
 * formatting and never its content; attributes not on the list are discarded
 * outright. That is also the sanitizer: this markup comes from a file that was
 * dropped onto the page, and the output goes into the document as HTML, so
 * nothing may pass through on the strength of not looking dangerous.
 */

import { XmlCursor, decodeEntities, skipElement, readTextContent, type Attrs } from "../xml/scan.ts";

export interface CdaSection {
  title: string;
  /** LOINC code for the section, when the document gives one. */
  code: string | null;
  /** Nesting level: 0 for a top-level section, 1 for a subsection. */
  level: number;
  /** Translated narrative, ready to insert as HTML. Empty when the section has none. */
  html: string;
  /** True when the narrative hit the size cap and was cut short. */
  clipped: boolean;
}

export interface SectionScan {
  sections: CdaSection[];
  /** True when the document ran past `maxSections` and the tail was not read. */
  truncated: boolean;
}

/** HL7 narrative elements that mean the same thing in HTML. */
const PASS_THROUGH = new Set([
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "col", "colgroup",
  "caption", "sup", "sub", "br",
]);

/** HL7 narrative elements with an HTML counterpart under another name. */
const RENAME: Readonly<Record<string, string>> = Object.freeze({
  paragraph: "p",
  content: "span",
  item: "li",
  footnote: "small",
  footnoteRef: "sup",
  linkHtml: "span", // Rendered as text: see the note on href below.
});

/** Elements that carry no text and must not be given a closing tag. */
const VOID = new Set(["br", "col"]);

/** The HTML name an element translates to, or null when it is unwrapped. Shared by
 *  the open and close branches so the two cannot disagree about what a tag became.
 *  `attrs` is absent on a close tag — only `list` reads them, and it is never void,
 *  so the branch that calls this on a close tag does not depend on the answer. */
function htmlNameOf(local: string, attrs?: Attrs): string | null {
  if (local === "list") return attrs?.listType === "ordered" ? "ol" : "ul";
  return PASS_THROUGH.has(local) ? local : RENAME[local] ?? null;
}

/**
 * Elements whose content is machine-facing rather than readable.
 *
 * `renderMultiMedia` points at an ObservationMedia elsewhere in the document —
 * an embedded image, which this viewer does not resolve. Dropping the element
 * whole is right: unwrapping it would leave a stray caption with nothing to
 * caption.
 */
const DROP_WHOLE = new Set(["renderMultiMedia"]);

/** Attributes kept, per element. Everything else is discarded. */
const ATTR_ALLOW: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  td: new Set(["colspan", "rowspan", "align", "valign"]),
  th: new Set(["colspan", "rowspan", "align", "valign"]),
  col: new Set(["span", "width"]),
  colgroup: new Set(["span"]),
});

/**
 * CDA style codes, mapped to classes the stylesheet understands.
 *
 * The `*rule` codes are how a CDA draws table borders, and they are the reason
 * vendor tables look like tables rather than a grid of loose cells. Anything
 * unrecognized is ignored rather than passed through as a class name.
 */
const STYLE_CLASS: Readonly<Record<string, string>> = Object.freeze({
  Bold: "cda-bold",
  Italics: "cda-italic",
  Underline: "cda-underline",
  Emphasis: "cda-emphasis",
  Botrule: "cda-botrule",
  Toprule: "cda-toprule",
  Lrule: "cda-lrule",
  Rrule: "cda-rrule",
});

const ESCAPE: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
});

/** Escape text for insertion into HTML, including in an attribute value. */
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPE[c]!);

/**
 * Escaped text cut to `room`, never inside an entity.
 *
 * The text is already escaped, so a naive slice can land inside `&amp;` and leave
 * `&am` — which the browser then reads as the start of something else. Backing off
 * to before the unterminated `&` costs at most five characters of the allowance.
 */
function cutText(escaped: string, room: number): string {
  const cut = escaped.slice(0, room);
  const amp = cut.lastIndexOf("&");
  return amp !== -1 && !cut.slice(amp).includes(";") ? cut.slice(0, amp) : cut;
}

function classesFor(attrs: Attrs): string {
  const raw = attrs.styleCode;
  if (!raw) return "";
  const names: string[] = [];
  for (const code of raw.split(/\s+/)) {
    const cls = STYLE_CLASS[code];
    if (cls && !names.includes(cls)) names.push(cls);
  }
  return names.join(" ");
}

function openTag(htmlName: string, sourceName: string, attrs: Attrs): string {
  let out = `<${htmlName}`;
  const allowed = ATTR_ALLOW[sourceName];
  if (allowed) {
    for (const [k, v] of Object.entries(attrs)) {
      // Numeric span attributes are re-emitted as digits only: the value comes
      // from the file, and `colspan` is one of the places a browser will take
      // whatever it is given.
      if (!allowed.has(k)) continue;
      const clean = (k === "colspan" || k === "rowspan" || k === "span")
        ? (/^\d{1,3}$/.test(v) ? v : null)
        : (/^[\w %-]{1,20}$/.test(v) ? v : null);
      if (clean !== null) out += ` ${k}="${escapeHtml(clean)}"`;
    }
  }
  const cls = classesFor(attrs);
  if (cls) out += ` class="${cls}"`;
  return out + ">";
}

/**
 * Translate one `<text>` block, with the cursor positioned just inside it.
 *
 * `budget` caps the output so a section whose narrative is a 6 MB table cannot
 * take the page down with it; the rest of the block is still consumed so the
 * cursor comes out at `</text>` either way.
 */
function translateNarrative(cur: XmlCursor, budget: number): { html: string; clipped: boolean } {
  let out = "";
  let clipped = false;
  // Appending a chunk whole once the budget still has room would let one 6 MB
  // run of text through on a 400 KB budget; what is left of the allowance is
  // the only correct limit.
  //
  // Text may be cut, markup may not. A tag sliced in half (`<td colspan="2`)
  // reaches the browser as attributes of a broken cell and eats whatever follows,
  // so a tag that does not fit is dropped whole and the element is treated as
  // unwrapped — its text still renders, it just loses its formatting.
  const append = (chunk: string): void => {
    const room = budget - out.length;
    if (room <= 0) { clipped = true; return; }
    if (chunk.length > room) { out += cutText(chunk, room); clipped = true; return; }
    out += chunk;
  };

  /** True if the tag fitted. A caller that gets false must not emit its closer. */
  const appendTag = (tag: string): boolean => {
    if (budget - out.length < tag.length) { clipped = true; return false; }
    out += tag;
    return true;
  };
  let depth = 1;
  // What is open, innermost last. `source` is the CDA element name, so a close
  // can be matched against what it claims to close; `html` is the tag to emit,
  // or null for an element that was unwrapped and emits nothing.
  const stack: { source: string; html: string | null }[] = [];

  for (let t = cur.next(); t !== null; t = cur.next()) {
    if (t.kind === "text") {
      append(escapeHtml(decodeEntities(t.raw)));
      continue;
    }
    if (t.kind === "comment" || t.kind === "pi") continue;

    if (t.kind === "close") {
      // A nested `</text>` belongs to the CDA element of that name, not to this
      // block: letting it fall through would close whatever encloses it.
      if (t.local === "text") { if (--depth === 0) break; continue; }
      // `<br></br>` and `<col></col>` are legal XML and do occur in vendor
      // narrative. The open branch emits a void element without pushing, so
      // popping here would close whatever ENCLOSES it — the paragraph ends early
      // and its remaining text escapes into the section body.
      const closing = htmlNameOf(t.local);
      if (closing !== null && VOID.has(closing)) continue;
      // Pop only what this tag actually closes. Vendor narrative carries stray
      // closes — a `</td>` with no `<td>` open — and popping on name alone ends
      // the enclosing element instead, spilling its remaining text into the
      // section body. A close that matches nothing open closes nothing.
      if (stack.length === 0 || stack[stack.length - 1]!.source !== t.local) continue;
      const { html } = stack.pop()!;
      // Closing tags bypass the budget: a clipped narrative that leaves an
      // element open would take the rest of the page inside it.
      if (html) out += `</${html}>`;
      continue;
    }

    if (t.local === "text") {
      if (!t.selfClose) depth += 1;
      continue;
    }
    if (DROP_WHOLE.has(t.local)) {
      if (!t.selfClose) skipElement(cur, t.local);
      continue;
    }

    const htmlName = htmlNameOf(t.local, t.attrs);

    if (htmlName === null) {
      // Unrecognized element: unwrap it. Its children still render.
      if (!t.selfClose) stack.push({ source: t.local, html: null });
      continue;
    }

    if (!appendTag(openTag(htmlName, t.local, t.attrs))) {
      // Out of room for the tag itself. `null` on the stack so this element's
      // close emits nothing — an unmatched `</td>` would be as broken as a
      // half-written open tag.
      if (!t.selfClose && !VOID.has(htmlName)) stack.push({ source: t.local, html: null });
      continue;
    }
    if (VOID.has(htmlName)) continue;
    if (t.selfClose) {
      out += `</${htmlName}>`; // its opener fitted, so its closer must follow it
      continue;
    }
    stack.push({ source: t.local, html: htmlName });
  }

  // A document that ends mid-block leaves tags open; close them so the section
  // cannot swallow the rest of the page.
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const html = stack[i]!.html;
    if (html) out += `</${html}>`;
  }
  return { html: out, clipped };
}

export interface SectionOptions {
  /** Stop after this many sections. */
  maxSections?: number;
  /** Cap on the translated HTML of a single section, in characters. */
  narrativeBudget?: number;
}

/**
 * Read every section of a C-CDA's clinical body.
 *
 * `<entry>` — the coded, machine-facing half of a section, and nearly all of the
 * bytes in a large document — is skipped without being translated.
 */
export function parseSections(xml: string, opts: SectionOptions = {}): SectionScan {
  const maxSections = opts.maxSections ?? 200;
  const budget = opts.narrativeBudget ?? 400_000;

  const cur = new XmlCursor(xml);
  const sections: CdaSection[] = [];
  let truncated = false;
  let level = -1;

  for (let t = cur.next(); t !== null; t = cur.next()) {
    if (t.kind === "close") {
      if (t.local === "section") level -= 1;
      continue;
    }
    if (t.kind !== "open") continue;

    if (t.local === "section") {
      if (t.selfClose) continue;
      level += 1;
      if (sections.length >= maxSections) { truncated = true; break; }
      sections.push({ title: "", code: null, level, html: "", clipped: false });
      continue;
    }

    const current = sections.at(-1);
    if (!current || level < 0) continue;

    switch (t.local) {
      case "title":
        // A self-closing `<title/>` has no content and no close tag. Reading one
        // as content sends the cursor looking for a `</title>` that never arrives,
        // and it consumes the rest of the document on the way — every later
        // section is lost and their text lands in this title. Vendor exports do
        // write an empty title this way.
        if (!t.selfClose) current.title = readTextContent(cur, "title");
        break;
      case "code":
        current.code ??= t.attrs.code ?? null;
        if (!current.title && t.attrs.displayName) current.title = t.attrs.displayName;
        if (!t.selfClose) skipElement(cur, "code");
        break;
      case "text":
        if (!t.selfClose) {
          const narrative = translateNarrative(cur, budget);
          current.html = narrative.html;
          current.clipped = narrative.clipped;
        }
        break;
      // The coded entries, the section's templateIds and its author block hold
      // nothing this view shows. Skipping `entry` is what makes a 12 MB
      // document cost about the same as a small one.
      case "entry":
      case "templateId":
      case "author":
      case "informant":
      case "subject":
        if (!t.selfClose) skipElement(cur, t.local);
        break;
      default:
        break;
    }
  }

  // A section with neither a title nor narrative is structural noise.
  return {
    sections: sections.filter((s) => s.title !== "" || s.html !== ""),
    truncated,
  };
}
