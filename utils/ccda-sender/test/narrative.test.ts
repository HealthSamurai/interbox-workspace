import { expect, test, describe } from "bun:test";
import { parseSections, escapeHtml } from "../src/cda/narrative.ts";

const doc = (body: string) =>
  `<ClinicalDocument xmlns="urn:hl7-org:v3"><component><structuredBody>${body}</structuredBody></component></ClinicalDocument>`;
const section = (inner: string) => doc(`<component><section>${inner}</section></component>`);
const narrativeOf = (inner: string) => parseSections(section(inner)).sections[0]?.html ?? "";

describe("section headings", () => {
  test("reads the title and the LOINC code", () => {
    const { sections } = parseSections(section(`<code code="46240-8" displayName="Encounters"/><title>Encounters</title><text><paragraph>x</paragraph></text>`));
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("Encounters");
    expect(sections[0]!.code).toBe("46240-8");
  });

  test("falls back to the code's display name when there is no title", () => {
    const { sections } = parseSections(section(`<code code="48765-2" displayName="Allergies and Intolerances"/><text><paragraph>x</paragraph></text>`));
    expect(sections[0]!.title).toBe("Allergies and Intolerances");
  });

  test("drops a section that carries neither a title nor narrative", () => {
    expect(parseSections(section(`<templateId root="1.2.3"/>`)).sections).toHaveLength(0);
  });

  test("does not take a code from inside a coded entry", () => {
    const { sections } = parseSections(section(
      `<title>Problems</title><text><paragraph>x</paragraph></text>` +
      `<entry><observation><code code="SHOULD-NOT-WIN"/></observation></entry>`));
    expect(sections[0]!.code).toBeNull();
  });

  test("records the nesting level of a subsection", () => {
    const { sections } = parseSections(doc(
      `<component><section><title>Parent</title><text><paragraph>a</paragraph></text>` +
      `<component><section><title>Child</title><text><paragraph>b</paragraph></text></section></component>` +
      `</section></component>`));
    expect(sections.map((s) => [s.title, s.level])).toEqual([["Parent", 0], ["Child", 1]]);
  });
});

describe("narrative translation", () => {
  test("renames the HL7 elements that have an HTML counterpart", () => {
    expect(narrativeOf(`<text><paragraph>Hello</paragraph></text>`)).toBe("<p>Hello</p>");
    expect(narrativeOf(`<text><content>Bold bit</content></text>`)).toBe("<span>Bold bit</span>");
  });

  test("renders a list, ordered or not", () => {
    expect(narrativeOf(`<text><list><item>a</item><item>b</item></list></text>`)).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(narrativeOf(`<text><list listType="ordered"><item>a</item></list></text>`)).toBe("<ol><li>a</li></ol>");
  });

  test("passes a table through with its structure intact", () => {
    const html = narrativeOf(`<text><table><thead><tr><th>Substance</th></tr></thead><tbody><tr><td>meperidine</td></tr></tbody></table></text>`);
    expect(html).toBe("<table><thead><tr><th>Substance</th></tr></thead><tbody><tr><td>meperidine</td></tr></tbody></table>");
  });

  test("turns an empty cell into a real empty cell, not a void tag", () => {
    expect(narrativeOf(`<text><table><tr><td styleCode="Botrule" /></tr></table></text>`))
      .toBe(`<table><tr><td class="cda-botrule"></td></tr></table>`);
  });

  test("keeps br as a void element", () => {
    expect(narrativeOf(`<text><paragraph>a<br/>b</paragraph></text>`)).toBe("<p>a<br>b</p>");
  });

  test("maps style codes to classes and ignores unknown ones", () => {
    expect(narrativeOf(`<text><content styleCode="Bold Italics">x</content></text>`))
      .toBe(`<span class="cda-bold cda-italic">x</span>`);
    expect(narrativeOf(`<text><content styleCode="xSomethingVendorSpecific">x</content></text>`)).toBe("<span>x</span>");
  });

  test("keeps colspan when it is a number and drops it when it is not", () => {
    expect(narrativeOf(`<text><table><tr><td colspan="3">x</td></tr></table></text>`))
      .toBe(`<table><tr><td colspan="3">x</td></tr></table>`);
    expect(narrativeOf(`<text><table><tr><td colspan="3&quot; onmouseover=&quot;alert(1)">x</td></tr></table></text>`))
      .toBe(`<table><tr><td>x</td></tr></table>`);
  });

  test("unwraps an unrecognized element but keeps its text", () => {
    expect(narrativeOf(`<text><vendorThing><paragraph>kept</paragraph></vendorThing></text>`)).toBe("<p>kept</p>");
  });

  test("drops renderMultiMedia whole, caption and all", () => {
    expect(narrativeOf(`<text><paragraph>a</paragraph><renderMultiMedia referencedObject="i1"><caption>Figure 1</caption></renderMultiMedia></text>`))
      .toBe("<p>a</p>");
  });

  test("resolves entities in narrative text", () => {
    expect(narrativeOf(`<text><paragraph>Smith &amp; Jones &lt;note&gt;</paragraph></text>`))
      .toBe("<p>Smith &amp; Jones &lt;note&gt;</p>");
  });
});

describe("narrative translation is the sanitizer", () => {
  test("a script element loses its tags and its content is inert text", () => {
    const html = narrativeOf(`<text><paragraph>before<script>alert(1)</script>after</paragraph></text>`);
    expect(html).not.toContain("<script");
    expect(html).toBe("<p>beforealert(1)after</p>");
  });

  test("an event handler attribute never survives", () => {
    const html = narrativeOf(`<text><paragraph onclick="alert(1)" onerror="alert(2)">x</paragraph></text>`);
    expect(html).toBe("<p>x</p>");
  });

  test("an img with an onerror handler is unwrapped entirely", () => {
    const html = narrativeOf(`<text><paragraph><img src="x" onerror="alert(1)"/></paragraph></text>`);
    expect(html).toBe("<p></p>");
  });

  test("a javascript: link cannot be clicked, because linkHtml renders as text", () => {
    const html = narrativeOf(`<text><paragraph><linkHtml href="javascript:alert(1)">click</linkHtml></paragraph></text>`);
    expect(html).toBe("<p><span>click</span></p>");
    expect(html).not.toContain("href");
  });

  test("a style element cannot restyle the page", () => {
    const html = narrativeOf(`<text><style>body{display:none}</style><paragraph>x</paragraph></text>`);
    expect(html).not.toContain("<style");
  });

  test("an inline style attribute is discarded", () => {
    expect(narrativeOf(`<text><table><tr><td style="position:fixed;inset:0">x</td></tr></table></text>`))
      .toBe(`<table><tr><td>x</td></tr></table>`);
  });

  test("markup that ends mid-block is closed rather than left open", () => {
    const html = parseSections(`<ClinicalDocument><component><structuredBody><component><section><title>T</title><text><table><tr><td>truncated`).sections[0]!.html;
    expect(html.endsWith("</td></tr></table>")).toBe(true);
  });
});

describe("limits", () => {
  test("a single section's narrative is capped", () => {
    const big = "x".repeat(5000);
    const html = narrativeOf(`<text><paragraph>${big}</paragraph></text>`);
    const capped = parseSections(section(`<text><paragraph>${big}</paragraph></text>`), { narrativeBudget: 100 }).sections[0]!.html;
    expect(html.length).toBeGreaterThan(5000);
    expect(capped.length).toBeLessThan(400);
  });

  test("says so when it clipped a narrative, and not when it did not", () => {
    const big = "x".repeat(5000);
    expect(parseSections(section(`<text><paragraph>${big}</paragraph></text>`), { narrativeBudget: 100 }).sections[0]!.clipped).toBe(true);
    expect(parseSections(section(`<text><paragraph>small</paragraph></text>`)).sections[0]!.clipped).toBe(false);
  });

  test("reports truncation when a document runs past the section limit", () => {
    const many = Array.from({ length: 12 }, (_, i) => `<component><section><title>S${i}</title></section></component>`).join("");
    const scan = parseSections(doc(many), { maxSections: 5 });
    expect(scan.truncated).toBe(true);
    expect(scan.sections.length).toBeLessThanOrEqual(5);
  });
});

describe("markup that ends an element early", () => {
  // Both of these cost the rest of the document, and both appear in vendor exports.
  test("a self-closing title does not swallow the sections after it", () => {
    const scan = parseSections(doc(
      `<component><section><title/><text><paragraph>Meds</paragraph></text></section></component>` +
      `<component><section><title>Problems</title><text><paragraph>List</paragraph></text></section></component>`,
    ));
    expect(scan.sections).toHaveLength(2);
    expect(scan.sections.map((s) => s.title)).toEqual(["", "Problems"]);
  });

  test("a close tag on a void element does not close its parent", () => {
    // `<br></br>` is legal XML. Popping the stack for it would end the paragraph
    // here and let the text after it escape into the section body.
    expect(narrativeOf(`<text><paragraph>a<br></br>b</paragraph><paragraph>second</paragraph></text>`))
      .toBe("<p>a<br>b</p><p>second</p>");
    expect(narrativeOf(`<text><table><colgroup><col></col></colgroup><tr><td>x</td></tr></table></text>`))
      .toBe("<table><colgroup><col></colgroup><tr><td>x</td></tr></table>");
  });

  test("lists still translate, with and without attributes on the close", () => {
    expect(narrativeOf(`<text><list listType="ordered"><item>one</item></list></text>`)).toBe("<ol><li>one</li></ol>");
    expect(narrativeOf(`<text><list><item>one</item></list></text>`)).toBe("<ul><li>one</li></ul>");
  });
});

describe("clipping a narrative that runs past its budget", () => {
  const rows = Array.from({ length: 8 }, (_, i) => `<tr><td colspan="2">cell ${i} with padding</td></tr>`).join("");
  const halfTag = /<[a-z]+[^>]*$|<\/[a-z]*$/i;

  test("never cuts inside a generated tag", () => {
    // A tag sliced in half goes into innerHTML as attributes of a broken cell and
    // swallows what follows. Text may be cut; markup may not.
    for (const narrativeBudget of [60, 90, 120, 160, 240]) {
      const html = parseSections(section(`<text><table>${rows}</table></text>`), { narrativeBudget })
        .sections[0]!.html;
      expect(html).not.toMatch(halfTag);
    }
  });

  test("never cuts inside an escaped entity", () => {
    const html = parseSections(section(`<text><paragraph>${"a&b ".repeat(40)}</paragraph></text>`),
      { narrativeBudget: 40 }).sections[0]!.html;
    expect(html).not.toMatch(/&[a-z]*$/i);
  });
});

describe("escapeHtml", () => {
  test("escapes every character that can change markup", () => {
    expect(escapeHtml(`<a href="x" t='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; t=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
});
