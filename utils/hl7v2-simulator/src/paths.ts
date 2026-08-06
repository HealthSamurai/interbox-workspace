// Default paths resolve against THIS package, not the caller's cwd.
//
// The simulator ships inside the workspace at utils/hl7v2-simulator/, so it is
// routinely started from the repo root (`bun --cwd utils/hl7v2-simulator run ui`,
// or the root `bun run simulator` script). Resolving `fixtures/profile.json` and
// friends relative to cwd would make those invocations fail with ENOENT — and,
// worse, scatter `data/sources.json` and `batch-out/` wherever the user happened
// to be standing. Anchoring on the package root keeps state in one place.
//
// A path the user passes explicitly (--profile, PROFILE_PATH, EXPORT_DIR, …) is
// still honoured as-is, so relative user paths keep resolving against their cwd.
import { readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Absolute path to this package's root — the directory holding package.json. */
export const PKG_ROOT = join(import.meta.dir, "..");

/** Resolve a package-relative path to an absolute one. */
export const pkgPath = (...parts: string[]): string => join(PKG_ROOT, ...parts);

/** The bundled synthetic generator profile. */
export const DEFAULT_PROFILE = pkgPath("fixtures", "profile.json");

/** Where the UI persists its source definitions. */
export const DEFAULT_SOURCES_PATH = pkgPath("data", "sources.json");

/** Where `/export` writes generated `.hl7` batches. */
export const DEFAULT_EXPORT_DIR = pkgPath("batch-out");

/**
 * Root that every caller-supplied export directory must stay inside.
 *
 * `/export` takes its `dir` from a request body, so without confinement it is an
 * arbitrary-filesystem write — and, with `clean`, an arbitrary delete. Point
 * EXPORT_ROOT somewhere else if you want batches written outside the package.
 */
export const EXPORT_ROOT = resolve(process.env.EXPORT_ROOT ?? DEFAULT_EXPORT_DIR);

/**
 * Resolve a caller-supplied export directory inside {@link EXPORT_ROOT}, or throw.
 *
 * Rejecting `..` and absolute paths textually is not enough: it still admits any
 * relative path under cwd, and on Windows it misses drive-relative (`C:foo`) and
 * UNC (`\\?\`, `\\server\share`) forms. Resolving first and then asking whether
 * the result is still under the root is the only check that is correct on both
 * platforms — an absolute input escapes at `resolve`, and is caught at `relative`.
 */
export function safeExportDir(dir: string): string {
  const abs = resolve(EXPORT_ROOT, dir);
  const rel = relative(EXPORT_ROOT, abs);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error(`dir must stay inside ${EXPORT_ROOT} (got ${dir})`);
  }
  return abs;
}

/**
 * Delete only the `.hl7` files this tool writes, leaving everything else alone.
 *
 * A blanket `rm` over every entry is wrong twice over: it destroys files the
 * user put there, and without `recursive` it throws on the first subdirectory —
 * after having already deleted whatever sorted ahead of it. Scoping the delete
 * means a mistargeted directory costs nothing.
 */
export async function cleanExports(dir: string): Promise<number> {
  let removed = 0;
  for (const f of await readdir(dir, { withFileTypes: true })) {
    if (!f.isFile() || !f.name.endsWith(".hl7")) continue;
    await rm(join(dir, f.name), { force: true });
    removed += 1;
  }
  return removed;
}
