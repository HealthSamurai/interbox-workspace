// Export-directory safety: what may be written, and what may be deleted.
//
// `POST /export` takes its directory from a request body, so these are the
// checks standing between a stray request and the user's filesystem.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanExports, EXPORT_ROOT, safeExportDir } from "../src/paths.ts";

let scratch = "";
beforeEach(async () => { scratch = await mkdtemp(join(tmpdir(), "hl7v2-export-")); });
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

test("safeExportDir keeps relative paths inside the export root", () => {
  expect(safeExportDir("batch")).toBe(join(EXPORT_ROOT, "batch"));
  expect(safeExportDir("nested/deeper")).toBe(join(EXPORT_ROOT, "nested", "deeper"));
  expect(safeExportDir("")).toBe(EXPORT_ROOT);
});

test("safeExportDir rejects traversal and absolute escapes", () => {
  expect(() => safeExportDir("../../etc")).toThrow(/must stay inside/);
  expect(() => safeExportDir("ok/../../..")).toThrow(/must stay inside/);
  // Absolute paths escape at resolve() and must be caught by the containment
  // check — this is the shape a CSRF request would use.
  expect(() => safeExportDir(process.platform === "win32" ? "C:\\Windows" : "/etc")).toThrow(/must stay inside/);
});

test("safeExportDir allows an absolute path that IS inside the root", () => {
  const inside = join(EXPORT_ROOT, "inside");
  expect(safeExportDir(inside)).toBe(inside);
});

// Prove-It: the old `clean` deleted every entry with a non-recursive rm, so it
// removed unrelated files and then threw on the first subdirectory — losing
// data AND failing. Names are chosen so the subdirectory sorts between them.
test("clean removes only our .hl7 files, and a subdirectory does not abort it", async () => {
  await writeFile(join(scratch, "aaa-precious.txt"), "do not delete me");
  await writeFile(join(scratch, "msg-1-ADT.hl7"), "MSH|...");
  await mkdir(join(scratch, "mmm-subdir"), { recursive: true });
  await writeFile(join(scratch, "mmm-subdir", "keep.txt"), "nested");
  await writeFile(join(scratch, "zzz-msg-2-ORU.hl7"), "MSH|...");

  const removed = await cleanExports(scratch);

  expect(removed).toBe(2);
  const left = (await readdir(scratch)).sort();
  expect(left).toEqual(["aaa-precious.txt", "mmm-subdir"]);
});

test("clean on a directory with nothing of ours is a no-op", async () => {
  await writeFile(join(scratch, "notes.md"), "mine");
  expect(await cleanExports(scratch)).toBe(0);
  expect(await readdir(scratch)).toEqual(["notes.md"]);
});
