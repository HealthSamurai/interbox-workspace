import { expect, test, describe } from "bun:test";
import { parseHeader, formatHl7Time } from "../src/cda/header.ts";

// Shaped after real vendor output: a nested author with its own id, code and
// effectiveTime sitting between the document's own header elements.
const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <realmCode code="US"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.1" extension="2015-08-01"/>
  <id root="1.2.840.113619.2" extension="VANFOND2"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1" displayName="Summarization of Episode Note"/>
  <title>Continuity of Care Document</title>
  <effectiveTime value="20260531101500-0500"/>
  <confidentialityCode code="N"/>
  <languageCode code="en-US"/>
  <recordTarget>
    <patientRole>
      <id root="1.2.840.113619.19.5" extension="MRN-422488"/>
      <id root="2.16.840.1.113883.4.1" extension="999-11-2222"/>
      <addr use="HP"><city>Kansas City</city></addr>
      <patient>
        <name use="L"><given>Howard</given><given>J</given><family>Lindqvist</family></name>
        <administrativeGenderCode code="M" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="19551103"/>
      </patient>
      <providerOrganization><name>Some Other Clinic</name></providerOrganization>
    </patientRole>
  </recordTarget>
  <author>
    <time value="20990101"/>
    <assignedAuthor>
      <id root="9.9.9" extension="AUTHOR-1"/>
      <code code="207Q00000X" displayName="Family Medicine"/>
      <assignedPerson><name><given>Bruce</given><family>Lee</family></name></assignedPerson>
    </assignedAuthor>
  </author>
  <custodian>
    <assignedCustodian>
      <representedCustodianOrganization>
        <id root="1.1.1"/>
        <name>Example General Hospital</name>
      </representedCustodianOrganization>
    </assignedCustodian>
  </custodian>
  <component><structuredBody><component><section><title>Ignored</title></section></component></structuredBody></component>
</ClinicalDocument>`;

describe("parseHeader", () => {
  const h = parseHeader(DOC);

  test("recognises a clinical document", () => {
    expect(h.isClinicalDocument).toBe(true);
  });

  test("takes the document's own id, not the author's", () => {
    expect(h.documentId).toBe("1.2.840.113619.2^VANFOND2");
  });

  test("takes the document's own effectiveTime, not the author's time", () => {
    expect(h.effectiveTime).toBe("20260531101500-0500");
  });

  test("prefers the written title over the code's display name", () => {
    expect(h.title).toBe("Continuity of Care Document");
    expect(h.typeCode).toBe("34133-9");
  });

  test("joins every given name with the family name", () => {
    expect(h.patientName).toBe("Howard J Lindqvist");
  });

  test("takes the first role identifier as the MRN", () => {
    expect(h.mrn).toBe("MRN-422488");
  });

  test("reads birth date and sex", () => {
    expect(h.birthTime).toBe("19551103");
    expect(h.sex).toBe("male");
  });

  test("reads the custodian organization", () => {
    expect(h.custodian).toBe("Example General Hospital");
  });

  test("does not mistake a provider organization's name for the patient's", () => {
    expect(h.patientName).not.toBe("Some Other Clinic");
  });
});

describe("parseHeader on input that is not a CDA", () => {
  test("reports a non-clinical document", () => {
    expect(parseHeader(`<Bundle xmlns="http://hl7.org/fhir"><id value="x"/></Bundle>`).isClinicalDocument).toBe(false);
    expect(parseHeader(`not xml at all`).isClinicalDocument).toBe(false);
    expect(parseHeader(``).isClinicalDocument).toBe(false);
  });
});

describe("parseHeader on a truncated document", () => {
  test("returns the fields that fit in the slice", () => {
    const h2 = parseHeader(DOC.slice(0, 700));
    expect(h2.isClinicalDocument).toBe(true);
    expect(h2.title).toBe("Continuity of Care Document");
    expect(h2.custodian).toBeNull();
  });
});

describe("parseHeader on a document with an unprefixed namespace", () => {
  test("reads through a namespace prefix", () => {
    const h3 = parseHeader(`<hl7:ClinicalDocument xmlns:hl7="urn:hl7-org:v3"><hl7:title>Prefixed</hl7:title></hl7:ClinicalDocument>`);
    expect(h3.isClinicalDocument).toBe(true);
    expect(h3.title).toBe("Prefixed");
  });
});

describe("formatHl7Time", () => {
  test("renders date and time as written, without shifting zones", () => {
    expect(formatHl7Time("20260531101500-0500")).toBe("2026-05-31 10:15");
  });

  test("renders a date-only value", () => {
    expect(formatHl7Time("19551103")).toBe("1955-11-03");
  });

  test("renders a year-month value", () => {
    expect(formatHl7Time("202605")).toBe("2026-05");
  });

  test("returns null for missing or unparseable input", () => {
    expect(formatHl7Time(null)).toBeNull();
    expect(formatHl7Time("")).toBeNull();
    expect(formatHl7Time("nonsense")).toBeNull();
  });
});
