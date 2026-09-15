/**
 * Decode a document by the encoding it declares, not by hope.
 *
 * A C-CDA carries its encoding in the XML declaration, and vendor exports do use
 * windows-1252 and ISO-8859-1. Decoding those as UTF-8 turns every accented name
 * into U+FFFD, so the tool would misreport a patient whose bytes are perfectly
 * fine. The declaration is ASCII in every encoding this covers, so it can be read
 * from the head of the buffer before anything else is decoded.
 *
 * An unknown or unsupported label falls back to UTF-8: a wrong guess renders
 * badly, while refusing the file renders nothing at all.
 *
 * Shared by every path that turns bytes into text — the library scan, a document
 * opened from disk, and a file dropped onto the page. One document read two ways
 * has to produce one name.
 */

/** Enough of the head to hold an XML declaration, which precedes all content. */
const DECLARATION_BYTES = 200;

const declaredEncoding = (head: string): string | undefined =>
  /<\?xml[^>]*encoding=["']([\w.:-]+)["']/i.exec(head)?.[1];

export function decodeDocument(buf: ArrayBufferLike | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const head = new TextDecoder("ascii").decode(bytes.subarray(0, DECLARATION_BYTES));
  const declared = declaredEncoding(head);
  if (declared && !/^utf-?8$/i.test(declared)) {
    try {
      return new TextDecoder(declared, { fatal: false }).decode(bytes);
    } catch {
      // TextDecoder throws on a label it does not know — fall through to UTF-8.
    }
  }
  return new TextDecoder().decode(bytes);
}
