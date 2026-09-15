/**
 * XML rendered for reading: coloured, and cut to a line budget.
 *
 * Highlighting re-emits the source verbatim, character for character, and only
 * wraps runs of it in spans. Nothing is normalized, reflowed or re-indented,
 * because the point of this view is to show what is actually in the file — a
 * stray tab or a 40 KB single line is information when a document has just been
 * rejected.
 *
 * Line breaks survive the pass unchanged, which is what lets the viewer put a
 * plain column of numbers beside the code and have them line up.
 */

import { escapeHtml } from "./narrative.ts";
import { XmlCursor, decodeEntities } from "../xml/scan.ts";

/**
 * Whether a document has line structure worth preserving.
 *
 * Most real C-CDA exports are written as a single line — a 12 MB document with
 * no newline in it is ordinary, not a corruption. Showing that faithfully means
 * showing one line and a horizontal scrollbar, which is unreadable, so the
 * viewer re-indents those and says that it did.
 */
export const isMinified = (xml: string, lines: number): boolean =>
  lines > 0 && xml.length / lines > 400;

export interface FormatResult {
  text: string;
  lines: number;
  /** False when formatting stopped at the line budget. */
  complete: boolean;
}

/**
 * Re-indent XML for reading, one element per line.
 *
 * An element whose content is only text keeps that text on its own line, which
 * is what makes a CDA header readable at a glance. Formatting stops as soon as
 * `maxLines` is reached, so a 12 MB single-line document costs one screenful of
 * work rather than twelve megabytes of it.
 */
export function formatXml(xml: string, maxLines: number): FormatResult {
  const cur = new XmlCursor(xml);
  const parts: string[] = [];
  let lines = 0;
  let depth = 0;
  let pendingText = "";
  // Whether the element at each depth has had a child element emitted, which
  // decides whether its closing tag goes on a fresh line.
  const hadChild: boolean[] = [];

  const indent = (n: number): string => "  ".repeat(Math.max(0, n));
  const breakLine = (n: number): boolean => {
    if (lines >= maxLines) return false;
    parts.push(lines === 0 ? "" : "\n", indent(n));
    lines += 1;
    return true;
  };
  const flushText = (): void => {
    if (pendingText === "") return;
    parts.push(pendingText);
    pendingText = "";
  };

  for (let t = cur.next(); t !== null; t = cur.next()) {
    if (lines >= maxLines) return { text: parts.join(""), lines, complete: false };

    if (t.kind === "text") {
      const trimmed = t.raw.replace(/\s+/g, " ").trim();
      if (trimmed !== "") pendingText += trimmed;
      continue;
    }

    if (t.kind === "comment" || t.kind === "pi") {
      flushText();
      if (!breakLine(depth)) break;
      parts.push(xml.slice(t.start, t.end));
      continue;
    }

    if (t.kind === "open") {
      flushText();
      if (!breakLine(depth)) break;
      parts.push(xml.slice(t.start, t.end));
      if (depth > 0) hadChild[depth - 1] = true;
      if (!t.selfClose) { hadChild[depth] = false; depth += 1; }
      continue;
    }

    // close
    depth = Math.max(0, depth - 1);
    if (hadChild[depth]) {
      flushText();
      if (!breakLine(depth)) break;
    } else {
      flushText();
    }
    parts.push(xml.slice(t.start, t.end));
  }

  flushText();
  return { text: parts.join(""), lines: Math.max(lines, 1), complete: true };
}

export interface XmlSlice {
  /** Highlighted HTML for the lines that were kept. */
  html: string;
  /** Lines in the whole document. */
  totalLines: number;
  /** Lines actually rendered. */
  shownLines: number;
  /** Characters in the whole document. */
  totalChars: number;
  /** True when the viewer re-indented the document to make it readable. */
  reformatted: boolean;
  /** False when there is more of the document than was rendered. */
  complete: boolean;
}

/**
 * Split off the first `maxLines` lines of `xml`.
 *
 * Works on the string rather than an array of lines so a 12 MB document is not
 * copied in full to read its first screen.
 */
export function takeLines(xml: string, maxLines: number): { text: string; shownLines: number; totalLines: number } {
  let cut = -1;
  let seen = 0;
  for (let i = 0; i < xml.length; i += 1) {
    if (xml.charCodeAt(i) !== 10) continue;
    seen += 1;
    if (seen === maxLines) { cut = i; break; }
  }
  if (cut === -1) {
    // Fewer lines than the budget: the whole document is the slice. The last
    // line counts even when the file does not end in a newline.
    let total = 0;
    for (let i = 0; i < xml.length; i += 1) if (xml.charCodeAt(i) === 10) total += 1;
    const totalLines = xml.length === 0 ? 0 : total + (xml.endsWith("\n") ? 0 : 1);
    return { text: xml, shownLines: totalLines, totalLines };
  }
  let total = 0;
  for (let i = 0; i < xml.length; i += 1) if (xml.charCodeAt(i) === 10) total += 1;
  return {
    text: xml.slice(0, cut),
    shownLines: maxLines,
    totalLines: total + (xml.endsWith("\n") ? 0 : 1),
  };
}

/**
 * Color one tag.
 *
 * The alternation ends in a catch-all for a single character, so every byte of
 * the input is accounted for by some branch and the output is always the input
 * with spans added — never the input with pieces missing.
 */
const TAG_PATTERN = /(<\/?)([A-Za-z_][\w:.-]*)|([A-Za-z_][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*')|(\/?>)|([\s\S])/g;

function highlightTag(raw: string): string {
  let out = "";
  TAG_PATTERN.lastIndex = 0;
  for (let m = TAG_PATTERN.exec(raw); m !== null; m = TAG_PATTERN.exec(raw)) {
    const [, bracket, elementName, attrName, equals, attrValue, closeBracket, other] = m;
    if (elementName !== undefined) out += `<span class="xp">${escapeHtml(bracket!)}</span><span class="xe">${escapeHtml(elementName)}</span>`;
    else if (attrName !== undefined) out += `<span class="xa">${escapeHtml(attrName)}</span><span class="xp">${escapeHtml(equals!)}</span><span class="xv">${escapeHtml(attrValue!)}</span>`;
    else if (closeBracket !== undefined) out += `<span class="xp">${escapeHtml(closeBracket)}</span>`;
    else out += escapeHtml(other!);
  }
  return out;
}

/** Highlight XML markup, preserving every character and every line break. */
export function highlightXml(xml: string): string {
  const cur = new XmlCursor(xml);
  let out = "";
  for (let t = cur.next(); t !== null; t = cur.next()) {
    const raw = xml.slice(t.start, t.end);
    switch (t.kind) {
      case "open":
      case "close": out += highlightTag(raw); break;
      case "comment": out += `<span class="xc">${escapeHtml(raw)}</span>`; break;
      case "pi": out += `<span class="xd">${escapeHtml(raw)}</span>`; break;
      case "text": out += escapeHtml(raw); break;
    }
  }
  return out;
}

/**
 * Prepare a document for the XML view.
 *
 * `raw` forces the file's own line structure even when it has none — the escape
 * hatch for a reader who needs to see the bytes rather than a readable version
 * of them.
 */
export function highlightSlice(xml: string, maxLines: number, raw = false): XmlSlice {
  const { text, shownLines, totalLines } = takeLines(xml, maxLines);

  if (!raw && isMinified(xml, totalLines)) {
    const formatted = formatXml(xml, maxLines);
    return {
      html: highlightXml(formatted.text),
      totalLines,
      shownLines: formatted.lines,
      totalChars: xml.length,
      reformatted: true,
      complete: formatted.complete,
    };
  }

  return {
    html: highlightXml(text),
    totalLines,
    shownLines,
    totalChars: xml.length,
    reformatted: false,
    complete: shownLines >= totalLines,
  };
}
