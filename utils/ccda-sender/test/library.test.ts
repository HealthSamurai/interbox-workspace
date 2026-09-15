import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanLibrary, findSample, formatBytes, probeDirectory, listDirectory, normalizeDir } from "../src/library.ts";
import { homedir } from "node:os";

const CDA = (name: string, mrn: string) => `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <id root="1.2.3" extension="DOC1"/>
  <code code="34133-9" displayName="Summarization of Episode Note"/>
  <title>Continuity of Care Document</title>
  <effectiveTime value="20260531101500-0500"/>
  <recordTarget><patientRole><id root="1.1" extension="${mrn}"/>
    <patient><name><given>${name}</given><family>Test</family></name></patient>
  </patientRole></recordTarget>
</ClinicalDocument>`;

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ccda-lib-"));
  mkdirSync(join(root, "Alpha"));
  mkdirSync(join(root, "Beta"));
  writeFileSync(join(root, "Alpha", "b.xml"), CDA("Bea", "MRN-2"));
  writeFileSync(join(root, "Alpha", "a.xml"), CDA("Ada", "MRN-1"));
  writeFileSync(join(root, "Alpha", "notes.txt"), "ignored");
  writeFileSync(join(root, "Beta", "c.xml"), `<Bundle xmlns="http://hl7.org/fhir"/>`);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("scanLibrary", () => {
  test("groups by directory and sorts files by name", () => {
    const lib = scanLibrary([
      { dir: join(root, "Alpha"), label: "Alpha" },
      { dir: join(root, "Beta"), label: "Beta" },
    ]);
    expect(lib.groups.map((g) => g.label)).toEqual(["Alpha", "Beta"]);
    expect(lib.groups[0]!.samples.map((s) => s.file)).toEqual(["a.xml", "b.xml"]);
    expect(lib.total).toBe(3);
  });

  test("describes each document from its header", () => {
    const s = scanLibrary([{ dir: join(root, "Alpha"), label: "Alpha" }]).groups[0]!.samples[0]!;
    expect(s.patientName).toBe("Ada Test");
    expect(s.title).toBe("Continuity of Care Document");
    expect(s.date).toBe("2026-05-31 10:15");
    expect(s.isClinicalDocument).toBe(true);
    expect(s.bytes).toBeGreaterThan(0);
  });

  test("flags a file that is not a clinical document rather than hiding it", () => {
    const s = scanLibrary([{ dir: join(root, "Beta"), label: "Beta" }]).groups[0]!.samples[0]!;
    expect(s.isClinicalDocument).toBe(false);
    expect(s.patientName).toBeNull();
  });

  test("ignores files that are not XML", () => {
    const files = scanLibrary([{ dir: join(root, "Alpha"), label: "Alpha" }]).groups[0]!.samples.map((s) => s.file);
    expect(files).not.toContain("notes.txt");
  });

  test("reports a missing directory on the group instead of failing the scan", () => {
    const lib = scanLibrary([
      { dir: join(root, "Nope"), label: "Nope" },
      { dir: join(root, "Alpha"), label: "Alpha" },
    ]);
    expect(lib.groups[0]!.error).toBe("Directory not found");
    expect(lib.groups[1]!.samples).toHaveLength(2);
  });

  test("gives each document a unique id", () => {
    const lib = scanLibrary([
      { dir: join(root, "Alpha"), label: "Alpha" },
      { dir: join(root, "Beta"), label: "Beta" },
    ]);
    const ids = lib.groups.flatMap((g) => g.samples.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("findSample", () => {
  const lib = () => scanLibrary([{ dir: join(root, "Alpha"), label: "Alpha" }]);

  test("resolves an id from the scan", () => {
    const l = lib();
    expect(findSample(l, l.groups[0]!.samples[1]!.id)!.file).toBe("b.xml");
  });

  test("refuses anything that is not an id it handed out", () => {
    // Documents are addressed by id, not by path, so a request cannot name a
    // file the scan did not find.
    const l = lib();
    for (const attempt of ["../../etc/passwd", "/etc/passwd", "0.99", "", "a.xml"]) {
      expect(findSample(l, attempt)).toBeNull();
    }
  });
});

describe("formatBytes", () => {
  test("uses the unit a file list would", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(3686)).toBe("3.6 KB");
    expect(formatBytes(11_914_393)).toBe("11.4 MB");
  });
});

describe("normalizeDir", () => {
  test("expands a leading ~ to the home directory", () => {
    expect(normalizeDir("~/somewhere")).toBe(join(homedir(), "somewhere"));
    expect(normalizeDir("~")).toBe(homedir());
  });

  test("does not touch a ~ that is part of a name", () => {
    expect(normalizeDir("/tmp/~backup")).toBe("/tmp/~backup");
  });

  test("makes a relative path absolute", () => {
    expect(normalizeDir("relative/bit").startsWith("/")).toBe(true);
  });

  test("strips the quotes a pasted path arrives wrapped in", () => {
    // Dragging a folder into a terminal, then copying, is how these paths get
    // quotes on them.
    expect(normalizeDir('"/tmp/some folder"')).toBe("/tmp/some folder");
    expect(normalizeDir("  /tmp/x  ")).toBe("/tmp/x");
  });

  test("returns nothing for nothing", () => {
    expect(normalizeDir("   ")).toBe("");
  });
});

describe("probeDirectory", () => {
  test("counts the documents in a real folder and names the group", () => {
    const p = probeDirectory(join(root, "Alpha"));
    expect(p.isDirectory).toBe(true);
    expect(p.documents).toBe(2);
    expect(p.label).toBe("Alpha");
    expect(p.error).toBeNull();
  });

  test("says a folder is not there rather than reporting zero documents", () => {
    const p = probeDirectory(join(root, "Missing"));
    expect(p.exists).toBe(false);
    expect(p.error).toBe("No such folder");
  });

  test("tells a file apart from a folder", () => {
    const p = probeDirectory(join(root, "Alpha", "a.xml"));
    expect(p.isDirectory).toBe(false);
    expect(p.error).toBe("That is a file, not a folder");
  });

  test("flags a real folder with nothing in it, without calling it an error of yours", () => {
    mkdirSync(join(root, "Empty"), { recursive: true });
    const p = probeDirectory(join(root, "Empty"));
    expect(p.isDirectory).toBe(true);
    expect(p.documents).toBe(0);
    expect(p.error).toBe("No .xml files in this folder");
  });

  test("asks for a path when given none", () => {
    expect(probeDirectory("  ").error).toBe("Type or paste a folder path.");
  });
});

describe("scanning a folder with subfolders in it", () => {
  let nested = "";
  beforeAll(() => {
    nested = mkdtempSync(join(tmpdir(), "ccda-nested-"));
    mkdirSync(join(nested, "2026"), { recursive: true });
    writeFileSync(join(nested, "top.xml"), CDA("Top", "MRN-T"));
    writeFileSync(join(nested, "2026", "m1.xml"), CDA("March One", "MRN-M1"));
  });
  afterAll(() => rmSync(nested, { recursive: true, force: true }));

  test("reads the top level only", () => {
    const lib = scanLibrary([{ dir: nested, label: "Archive" }]);
    expect(lib.total).toBe(1);
    expect(lib.groups[0]!.samples[0]!.file).toBe("top.xml");
  });

  test("counts what is one level down too, so picking the wrong level shows", () => {
    const p = probeDirectory(nested);
    expect(p.documents).toBe(1);
    expect(p.documentsBelow).toBe(1);
    expect(p.subfolders).toBe(1);
  });
});

describe("listDirectory", () => {
  let tree = "";
  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), "ccda-tree-"));
    mkdirSync(join(tree, "Beta"));
    mkdirSync(join(tree, "Alpha"));
    mkdirSync(join(tree, ".git"));
    writeFileSync(join(tree, "loose.xml"), CDA("Loose", "MRN-L"));
    writeFileSync(join(tree, "Alpha", "one.xml"), CDA("One", "MRN-1"));
    writeFileSync(join(tree, "Alpha", "two.xml"), CDA("Two", "MRN-2"));
  });
  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  test("lists subfolders in name order with their document counts", () => {
    const listing = listDirectory(tree);
    expect(listing.entries.map((e) => e.name)).toEqual(["Alpha", "Beta"]);
    expect(listing.entries[0]!.documents).toBe(2);
    expect(listing.entries[1]!.documents).toBe(0);
  });

  test("counts the documents sitting loose in the folder itself", () => {
    const listing = listDirectory(tree);
    expect(listing.documents).toBe(1);
    expect(listing.documentsBelow).toBe(2);
  });

  test("offers the folder above, and stops at the root", () => {
    expect(listDirectory(tree).parent).toBe(resolve(tree, ".."));
    expect(listDirectory("/").parent).toBeNull();
  });

  test("hides dot-folders", () => {
    expect(listDirectory(tree).entries.map((e) => e.name)).not.toContain(".git");
  });

  test("starts at home when given nothing", () => {
    expect(listDirectory("").dir).toBe(homedir());
  });

  test("explains a folder it cannot open instead of showing it empty", () => {
    const listing = listDirectory(join(tree, "Nope"));
    expect(listing.error).toBe("No such folder");
    expect(listing.entries).toEqual([]);
  });
});
