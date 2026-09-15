/**
 * Where the documents are and where they are sent.
 *
 * Sample directories have no built-in default and never will. A path on one
 * machine is wrong on every other one, and a directory named after whoever
 * supplied the documents is a name that does not belong in a repository. Both
 * problems disappear if the tool simply refuses to guess: the directories come
 * from the environment or from a local file, a group is named after its
 * directory, and an unconfigured sender says so instead of finding nothing.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CONFIG_PATH } from "./paths.ts";

export interface LibraryRoot {
  /** Group heading in the library — the directory's own name unless overridden. */
  label: string;
  dir: string;
}

export interface SenderConfig {
  roots: LibraryRoot[];
  /** Where documents are POSTed. Editable in the UI; this is the starting value. */
  endpoint: string;
  /** The file the configuration is read from and written back to. */
  configPath: string;
  /** False when that file does not exist yet. */
  configExists: boolean;
  /**
   * True when `CCDA_SAMPLE_DIRS` is what the listed folders came from.
   *
   * The environment wins, which means edits made in the window would be saved
   * and then ignored. The UI says so rather than appearing to do nothing — so
   * this has to describe what actually happened, not merely that the variable
   * was set: a value that parses to no folders leaves the file in charge.
   */
  envOverride: boolean;
  /**
   * The endpoint as the FILE has it, absent when the file names none.
   *
   * Kept apart from the effective `endpoint`, which the environment may have
   * supplied. Writing the effective one back would silently bake a one-off
   * `CCDA_URL` into the file the next time anyone saves a folder.
   */
  fileEndpoint: string | null;
  /** Why the library is empty, when it is. */
  problem: string | null;
}

/** The engine's C-CDA receiver on the stand this tool is built alongside. */
export const DEFAULT_ENDPOINT = "http://localhost:2880/ccda";

/** A directory's own name — what a group is called unless you say otherwise. */
export const basename = (dir: string): string => {
  const trimmed = dir.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
};

/**
 * Read `CCDA_SAMPLE_DIRS` — one or more directories separated by the platform's
 * path separator, or by a comma.
 */
export function parseDirList(spec: string): LibraryRoot[] {
  return spec
    .split(/[:;,]/)
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((dir) => ({ dir, label: basename(dir) }));
}

interface ConfigFile {
  endpoint?: unknown;
  roots?: unknown;
}

function readConfigFile(path: string): { roots: LibraryRoot[]; endpoint: string | null } | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: ConfigFile;
  try {
    parsed = JSON.parse(raw) as ConfigFile;
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }

  const roots: LibraryRoot[] = [];
  if (Array.isArray(parsed.roots)) {
    for (const entry of parsed.roots) {
      // Both spellings produce the same shape. A root that came in as a bare
      // string and one that came in as an object must be indistinguishable
      // afterwards, or every reader has to handle two kinds of root.
      if (typeof entry === "string") roots.push({ dir: entry, label: basename(entry) });
      else if (entry && typeof entry === "object" && typeof (entry as LibraryRoot).dir === "string") {
        const e = entry as LibraryRoot;
        roots.push({
          dir: e.dir,
          label: typeof e.label === "string" && e.label !== "" ? e.label : basename(e.dir),
        });
      }
    }
  }
  return { roots, endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : null };
}

/**
 * Resolve the sender's configuration.
 *
 * The environment wins over the file so a single run can be pointed somewhere
 * else without editing anything.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): SenderConfig {
  const configPath = env.CCDA_SENDER_CONFIG ?? DEFAULT_CONFIG_PATH;
  let fromFile: { roots: LibraryRoot[]; endpoint: string | null } | null = null;
  let problem: string | null = null;
  try {
    fromFile = readConfigFile(configPath);
  } catch (err) {
    problem = (err as Error).message;
  }

  const fromEnv = env.CCDA_SAMPLE_DIRS ? parseDirList(env.CCDA_SAMPLE_DIRS) : [];
  const envOverride = fromEnv.length > 0;
  const roots = envOverride ? fromEnv : fromFile?.roots ?? [];

  if (problem === null && roots.length === 0) {
    problem = "No folders yet. Add one in Library settings, or set CCDA_SAMPLE_DIRS.";
  }

  return {
    roots,
    endpoint: env.CCDA_URL ?? fromFile?.endpoint ?? DEFAULT_ENDPOINT,
    fileEndpoint: fromFile?.endpoint ?? null,
    configPath,
    configExists: fromFile !== null,
    envOverride,
    problem,
  };
}

/**
 * Write the configuration back.
 *
 * Only the two things a person edits are stored — the folders and the endpoint
 * — so the file stays something you can also open in an editor and understand.
 */
export function saveConfig(configPath: string, next: { roots: LibraryRoot[]; endpoint: string }): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const body = {
    endpoint: next.endpoint,
    roots: next.roots.map((r) => (r.label === basename(r.dir) ? r.dir : { dir: r.dir, label: r.label })),
  };
  writeFileSync(configPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

/** A directory as the settings panel needs to describe it, before it is saved. */
export interface DirProbe {
  dir: string;
  exists: boolean;
  isDirectory: boolean;
  /** How many .xml files are in it — the number that decides whether it is the right folder. */
  documents: number;
  /** How many sit in its immediate subfolders — the hint that you picked one level too high. */
  documentsBelow: number;
  /** Subfolders directly inside it. */
  subfolders: number;
  label: string;
  error: string | null;
}

/** One row of the folder browser. */
export interface DirEntry {
  name: string;
  path: string;
  documents: number;
  subfolders: number;
}

export interface DirListing {
  dir: string;
  /** The folder above this one, or null at the top of the tree. */
  parent: string | null;
  entries: DirEntry[];
  documents: number;
  documentsBelow: number;
  error: string | null;
}
