/**
 * Paths resolve against this package, not the caller's working directory.
 *
 * The sender ships inside the workspace at utils/ccda-sender/ and is normally
 * started from the repo root (`bun run ccda:sender`), so anchoring on the
 * package keeps its state in one place instead of scattering it wherever the
 * shell happened to be.
 */
import { join } from "node:path";

/** Absolute path to this package's root — the directory holding package.json. */
export const PKG_ROOT = join(import.meta.dir, "..");

/** Resolve a package-relative path to an absolute one. */
export const pkgPath = (...parts: string[]): string => join(PKG_ROOT, ...parts);

/** Where the library configuration is read from when the environment is silent. */
export const DEFAULT_CONFIG_PATH = pkgPath("data", "library.json");
