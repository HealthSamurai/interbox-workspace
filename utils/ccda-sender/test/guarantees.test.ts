/**
 * The properties this tool is trusted for, pinned so a refactor cannot quietly
 * drop one.
 *
 * Everything here is stated in the README or in a doc comment as something the
 * sender guarantees. Each was verified by hand once; a test is what keeps it
 * true. None of them has an example-based test elsewhere, because each is about
 * what the code REFUSES rather than what it produces.
 */

import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanLibrary, findSample } from "../src/library.ts";
import { parseSections } from "../src/cda/narrative.ts";
import { parseHeader } from "../src/cda/header.ts";
import { decodeDocument } from "../src/decode.ts";

const CDA = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><patient><name><given>A</given><family>B</family></name></patient></patientRole></recordTarget>
</ClinicalDocument>`;

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ccda-guarantees-"));
  writeFileSync(join(dir, "one.xml"), CDA);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a document is addressed by id, never by a path from the request", () => {
  // The README says a filename in a URL cannot reach a file the scan did not
  // find. That holds because ids are issued by the scan and resolved against it.
  test("a traversal string resolves to nothing", () => {
    const library = scanLibrary([{ dir, label: "L" }]);
    for (const attempt of [
      "../../../../etc/passwd",
      "/etc/passwd",
      "..%2f..%2fetc%2fpasswd",
      "one.xml",
      "",
    ]) {
      expect(findSample(library, attempt)).toBeNull();
    }
  });

  test("the id the scan issued does resolve", () => {
    const library = scanLibrary([{ dir, label: "L" }]);
    const id = library.groups[0]!.samples[0]!.id;
    expect(findSample(library, id)?.file).toBe("one.xml");
    // Derived from the path, so it is stable across scans rather than being a
    // position that shifts when a neighbouring file appears.
    expect(scanLibrary([{ dir, label: "L" }]).groups[0]!.samples[0]!.id).toBe(id);
  });
});

describe("hostile input is answered, not thrown", () => {
  // A malformed document is ordinary in this corpus. Every reader has to come
  // back with something rather than take the process down.
  const inputs: Record<string, string> = {
    empty: "",
    whitespace: "   \n\t ",
    "not xml": "hello world",
    "nul bytes": "\0\0\0",
    "declaration only": '<?xml version="1.0"?>',
    "cut mid-tag": "<ClinicalDocument><component><section><title>T",
    "cut mid-attribute": '<section><code code="46240',
    "close with no open": "</section></component>",
    "duplicate attributes": '<td colspan="2" colspan="9">x</td>',
    "unterminated comment": "<!-- never ends",
  };

  for (const [label, xml] of Object.entries(inputs)) {
    test(`parses "${label}"`, () => {
      expect(() => parseSections(xml)).not.toThrow();
      expect(() => parseHeader(xml)).not.toThrow();
      expect(parseHeader(xml).patientName).toBeNull();
    });
  }

  test("deep nesting does not exhaust the stack", () => {
    // The cursor walks iteratively; a recursive parser dies here.
    expect(() => parseSections(`${"<x>".repeat(10_000)}text`)).not.toThrow();
  });

  test("a run of entities is decoded in linear time", () => {
    const started = performance.now();
    parseSections(`<ClinicalDocument><component><structuredBody><component><section>` +
      `<title>T</title><text><paragraph>${"&amp;".repeat(50_000)}</paragraph></text>` +
      `</section></component></structuredBody></component></ClinicalDocument>`);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("a document is decoded by the encoding it declares", () => {
  // One document read two ways has to produce one name: the library row and the
  // document sheet go through different readers.
  const win1252 = Uint8Array.from([
    ...new TextEncoder().encode('<?xml version="1.0" encoding="windows-1252"?><a>Bj'),
    0xf6,
    ...new TextEncoder().encode("rn</a>"),
  ]);

  test("a single-byte encoding survives", () => {
    expect(decodeDocument(win1252)).toContain("Björn");
  });

  test("an unknown label falls back rather than refusing the file", () => {
    const odd = new TextEncoder().encode('<?xml version="1.0" encoding="not-a-charset"?><a>x</a>');
    expect(decodeDocument(odd)).toContain("<a>x</a>");
  });

  test("the library row and a full read agree on the name", () => {
    const path = join(dir, "accented.xml");
    writeFileSync(path, Buffer.from(Uint8Array.from([
      ...new TextEncoder().encode('<?xml version="1.0" encoding="windows-1252"?>\n<ClinicalDocument xmlns="urn:hl7-org:v3"><recordTarget><patientRole><patient><name><given>Jos'),
      0xe9,
      ...new TextEncoder().encode("</given><family>Garcia</family></name></patient></patientRole></recordTarget></ClinicalDocument>"),
    ])));
    const row = scanLibrary([{ dir, label: "L" }]).groups[0]!.samples
      .find((s) => s.file === "accented.xml");
    expect(row?.patientName).toBe("José Garcia");
    rmSync(path);
  });
});

describe("the narrative budget produces markup a browser can parse", () => {
  const rows = Array.from({ length: 8 }, (_, i) => `<tr><td colspan="2">cell ${i} padding</td></tr>`).join("");
  const section = (inner: string) =>
    `<ClinicalDocument xmlns="urn:hl7-org:v3"><component><structuredBody><component>` +
    `<section><title>T</title>${inner}</section></component></structuredBody></component></ClinicalDocument>`;

  test("a clip never lands inside a tag", () => {
    for (const narrativeBudget of [40, 60, 90, 120, 160, 240]) {
      const html = parseSections(section(`<text><table>${rows}</table></text>`), { narrativeBudget })
        .sections[0]!.html;
      expect(html).not.toMatch(/<[a-z]+[^>]*$|<\/[a-z]*$/i);
    }
  });

  test("a close tag closes only what it opened", () => {
    // Vendor narrative carries stray closes; popping on arrival ends the
    // enclosing element and spills its text into the section body.
    const html = parseSections(section(`<text><paragraph>a</td>b</paragraph></text>`)).sections[0]!.html;
    expect(html).toBe("<p>ab</p>");
  });
});
