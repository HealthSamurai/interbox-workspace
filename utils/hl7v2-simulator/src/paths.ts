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
import { join } from "node:path";

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
