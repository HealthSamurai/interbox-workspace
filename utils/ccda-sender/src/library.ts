/**
 * The sample library: the documents on disk, grouped and described.
 *
 * Two things shape this file. The corpus is large — a hundred-odd documents
 * running to 12 MB each — so a scan reads the first slice of every file rather
 * than the whole thing, which is enough for the header and costs milliseconds
 * across the whole library. And a document is addressed by an opaque id that
 * the server resolves against the scan, never by a path from the request, so
 * there is no filename to sanitise and no traversal to defend against.
 */

import { createHash } from "node:crypto";
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { decodeDocument } from "./decode.ts";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseHeader, formatHl7Time, type CdaHeader } from "./cda/header.ts";
import { basename, type LibraryRoot, type DirProbe, type DirEntry, type DirListing } from "./config.ts";

/** How much of a document is read to describe it. The header is at the front. */
const HEADER_SLICE = 64 * 1024;

export interface Sample {
  /** Opaque, stable for the life of a scan. */
  id: string;
  file: string;
  group: string;
  path: string;
  bytes: number;
  patientName: string | null;
  title: string | null;
  /** The organization that holds the document — what tells two exports apart. */
  custodian: string | null;
  /** Document date, already formatted for display. */
  date: string | null;
  isClinicalDocument: boolean;
}

export interface SampleGroup {
  label: string;
  dir: string;
  samples: Sample[];
  /** Set when the directory could not be read. */
  error: string | null;
}

export interface Library {
  groups: SampleGroup[];
  total: number;
  scanMs: number;
}

/** Read the first bytes of a file without pulling the rest of it into memory. */
function readHead(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    // Decoded the same way a full read is, so the name in this list and the name
    // on the document sheet are the same name.
    return decodeDocument(buf.subarray(0, read));
  } finally {
    closeSync(fd);
  }
}

function describe(path: string): CdaHeader | null {
  try {
    return parseHeader(readHead(path, HEADER_SLICE));
  } catch {
    return null;
  }
}

/**
 * Scan the configured directories.
 *
 * Only the top level of each directory is read: a sample library is a flat
 * folder of documents, and recursing would silently pull in whatever else the
 * user keeps nearby.
 */
/**
 * A document's id: derived from its path, not from its position in the scan.
 *
 * A positional id is only stable while the directory is. Add a file that sorts
 * earlier and every later id shifts by one — a selection made before a rescan
 * then names a different document, and the tool sends one thing while showing
 * another. Deriving the id removes the class of bug rather than the instance:
 * an id keeps naming its own document across rescans, across tabs, and across
 * restarts, and one that no longer resolves is simply gone.
 *
 * Truncated to 12 hex characters — this addresses a local directory listing, not
 * a namespace where collisions are adversarial.
 */
const idFor = (path: string): string => createHash("sha256").update(path).digest("hex").slice(0, 12);

export function scanLibrary(roots: LibraryRoot[]): Library {
  const started = performance.now();
  const groups: SampleGroup[] = [];
  let total = 0;

  roots.forEach((root) => {
    const group: SampleGroup = { label: root.label, dir: root.dir, samples: [], error: null };
    groups.push(group);

    // Collect paths first, so the ids a scan hands out do not depend on the
    // order the filesystem happened to give.
    const paths: string[] = [];
    try {
      for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".xml")) paths.push(join(root.dir, entry.name));
      }
    } catch (err) {
      group.error = (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "Directory not found"
        : (err as Error).message;
      return;
    }

    paths.sort((a, b) => a.localeCompare(b));

    for (const path of paths) {
      let bytes: number;
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        bytes = st.size;
      } catch {
        continue;
      }
      const header = describe(path);
      group.samples.push({
        id: idFor(path),
        file: path.slice(root.dir.length).replace(/^[/\\]/, ""),
        group: root.label,
        path,
        bytes,
        patientName: header?.patientName ?? null,
        title: header?.title ?? null,
        custodian: header?.custodian ?? null,
        date: formatHl7Time(header?.effectiveTime),
        isClinicalDocument: header?.isClinicalDocument ?? false,
      });
      total += 1;
    }
  });

  return { groups, total, scanMs: performance.now() - started };
}

/** Find a sample by the id a scan gave it. Returns null for anything unknown. */
export function findSample(library: Library, id: string): Sample | null {
  for (const group of library.groups) {
    for (const sample of group.samples) if (sample.id === id) return sample;
  }
  return null;
}

/**
 * Expand `~` and make a path absolute.
 *
 * A path typed into a field is whatever the person had on their clipboard, and
 * a relative one would otherwise resolve against wherever the server happened
 * to be started from — which is never what they meant.
 */
export function normalizeDir(input: string): string {
  const trimmed = input.trim().replace(/^["']|["']$/g, "");
  const expanded = trimmed === "~" || trimmed.startsWith("~/")
    ? join(homedir(), trimmed.slice(1))
    : trimmed;
  return expanded === "" ? "" : resolve(expanded);
}

const isHidden = (name: string): boolean => name.startsWith(".");

/** Count `.xml` files directly inside a directory, and the subfolders it holds. */
function shallowCounts(dir: string): { documents: number; subfolders: number } {
  let documents = 0;
  let subfolders = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isHidden(entry.name)) continue;
    if (entry.isDirectory()) subfolders += 1;
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".xml")) documents += 1;
  }
  return { documents, subfolders };
}

/** Documents sitting one level down, summed over the immediate subfolders. */
function countBelow(dir: string): number {
  let below = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || isHidden(entry.name)) continue;
      try {
        below += shallowCounts(join(dir, entry.name)).documents;
      } catch { /* An unreadable subfolder simply contributes nothing. */ }
    }
  } catch { /* Handled by the caller, which already stat'd the directory. */ }
  return below;
}

/**
 * Look at a directory without adding it: is it there, and what is in it.
 *
 * Both counts are reported — what is at the top level and what is further down —
 * because the everyday mistake is picking the folder above or below the one that
 * actually holds the documents, and one number cannot tell you which you did.
 */
export function probeDirectory(input: string): DirProbe {
  const dir = normalizeDir(input);
  const blank: DirProbe = {
    dir, exists: false, isDirectory: false, documents: 0, documentsBelow: 0,
    subfolders: 0, label: basename(dir), error: null,
  };
  if (dir === "") return { ...blank, error: "Type or paste a folder path." };

  let stat;
  try {
    stat = statSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ...blank, error: code === "ENOENT" ? "No such folder" : (err as Error).message };
  }
  if (!stat.isDirectory()) return { ...blank, exists: true, error: "That is a file, not a folder" };

  try {
    const { documents, subfolders } = shallowCounts(dir);
    const below = countBelow(dir);
    return {
      dir, exists: true, isDirectory: true, documents, documentsBelow: below,
      subfolders, label: basename(dir),
      error: documents === 0 && below === 0 ? "No .xml files in this folder" : null,
    };
  } catch (err) {
    return { ...blank, exists: true, isDirectory: true, error: (err as Error).message };
  }
}

/**
 * List the subfolders of a directory, for picking one by clicking.
 *
 * A browser cannot hand a page the real path of a folder the user chose — the
 * native picker deliberately withholds it. Since the server is on the same
 * machine, it does the looking instead, and the page draws what it reports.
 * Only directories are listed: this is for choosing where documents are, not
 * for reading anything.
 */
export function listDirectory(input: string): DirListing {
  const dir = input.trim() === "" ? homedir() : normalizeDir(input);
  const parent = (() => {
    const up = resolve(dir, "..");
    return up === dir ? null : up;
  })();
  const blank: DirListing = { dir, parent, entries: [], documents: 0, documentsBelow: 0, error: null };

  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ...blank,
      error: code === "ENOENT" ? "No such folder"
        : code === "EACCES" || code === "EPERM" ? "No permission to look inside this folder"
        : (err as Error).message,
    };
  }

  const entries: DirEntry[] = [];
  let documents = 0;
  for (const entry of names) {
    if (isHidden(entry.name)) continue;
    if (entry.isDirectory()) {
      const path = join(dir, entry.name);
      let counts = { documents: 0, subfolders: 0 };
      try {
        counts = shallowCounts(path);
      } catch { /* Unreadable folders are still worth showing, just uncounted. */ }
      entries.push({ name: entry.name, path, documents: counts.documents, subfolders: counts.subfolders });
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".xml")) {
      documents += 1;
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const below = entries.reduce((n, e) => n + e.documents, 0);
  return { dir, parent, entries, documents, documentsBelow: below, error: null };
}

/** Human-readable size, in the units a person reading a file list expects. */
export function formatBytes(bytes: number): string {
  // A size that is not a number reaches the window as "NaN MB" otherwise, which
  // reads as a measurement rather than as the missing value it is.
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
