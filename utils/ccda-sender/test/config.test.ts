import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, parseDirList, DEFAULT_ENDPOINT } from "../src/config.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ccda-sender-"));

describe("parseDirList", () => {
  test("splits on the path separator and on commas", () => {
    expect(parseDirList("/samples/Northgate:/samples/Samples")).toEqual([
      { dir: "/samples/Northgate", label: "Northgate" },
      { dir: "/samples/Samples", label: "Samples" },
    ]);
    expect(parseDirList("/a/One, /b/Two").map((r) => r.label)).toEqual(["One", "Two"]);
  });

  test("names a group after its directory", () => {
    // The group heading is derived, never written down — which is what keeps
    // the name of whoever supplied the documents out of the repository.
    expect(parseDirList("/somewhere/Vendor Exports")[0]!.label).toBe("Vendor Exports");
  });

  test("tolerates a trailing separator and empty entries", () => {
    expect(parseDirList("/a/Samples/,,")).toEqual([{ dir: "/a/Samples/", label: "Samples" }]);
  });

  test("returns nothing for an empty spec", () => {
    expect(parseDirList("")).toEqual([]);
  });
});

describe("loadConfig", () => {
  test("guesses no sample directory, and points at the two ways to set one", () => {
    const cfg = loadConfig({ CCDA_SENDER_CONFIG: "/nonexistent/library.json" });
    expect(cfg.roots).toEqual([]);
    expect(cfg.problem).toContain("Library settings");
    expect(cfg.problem).toContain("CCDA_SAMPLE_DIRS");
  });

  test("falls back to the stand's receiver when no endpoint is configured", () => {
    expect(loadConfig({ CCDA_SENDER_CONFIG: "/nonexistent/x.json" }).endpoint).toBe(DEFAULT_ENDPOINT);
  });

  test("reads directories and endpoint from a config file", () => {
    const dir = tmp();
    const path = join(dir, "library.json");
    writeFileSync(path, JSON.stringify({
      endpoint: "http://localhost:9999/ccda",
      roots: ["/samples/Northgate", { dir: "/samples/x", label: "Renamed" }],
    }));
    const cfg = loadConfig({ CCDA_SENDER_CONFIG: path });
    // Both spellings arrive as the same shape.
    expect(cfg.roots).toEqual([
      { dir: "/samples/Northgate", label: "Northgate" },
      { dir: "/samples/x", label: "Renamed" },
    ]);
    expect(cfg.endpoint).toBe("http://localhost:9999/ccda");
    expect(cfg.problem).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the environment overrides the file", () => {
    const dir = tmp();
    const path = join(dir, "library.json");
    writeFileSync(path, JSON.stringify({ roots: ["/from/File"] }));
    const cfg = loadConfig({ CCDA_SENDER_CONFIG: path, CCDA_SAMPLE_DIRS: "/from/Env", CCDA_URL: "http://e/ccda" });
    expect(cfg.roots.map((r) => r.dir)).toEqual(["/from/Env"]);
    expect(cfg.endpoint).toBe("http://e/ccda");
    rmSync(dir, { recursive: true, force: true });
  });

  test("reports a broken config file instead of starting up empty and silent", () => {
    const dir = tmp();
    const path = join(dir, "library.json");
    writeFileSync(path, "{ not json");
    const cfg = loadConfig({ CCDA_SENDER_CONFIG: path });
    expect(cfg.problem).toContain("not valid JSON");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("saveConfig", () => {
  test("writes a file loadConfig reads back", () => {
    const dir = tmp();
    const path = join(dir, "nested", "library.json");
    saveConfig(path, {
      endpoint: "http://localhost:2880/ccda",
      roots: [{ dir: "/samples/Samples", label: "Samples" }, { dir: "/samples/x", label: "Custom" }],
    });
    const cfg = loadConfig({ CCDA_SENDER_CONFIG: path });
    expect(cfg.roots).toEqual([
      { dir: "/samples/Samples", label: "Samples" },
      { dir: "/samples/x", label: "Custom" },
    ]);
    expect(cfg.endpoint).toBe("http://localhost:2880/ccda");
    expect(cfg.configExists).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes a plain string when the heading is just the folder's name", () => {
    // Keeps the file something a person can also edit by hand without wading
    // through objects that say nothing.
    const dir = tmp();
    const path = join(dir, "library.json");
    saveConfig(path, { endpoint: "http://e/ccda", roots: [{ dir: "/samples/Samples", label: "Samples" }] });
    expect(JSON.parse(readFileSync(path, "utf8")).roots).toEqual(["/samples/Samples"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates the directory it is asked to write into", () => {
    const dir = tmp();
    const path = join(dir, "a", "b", "library.json");
    saveConfig(path, { endpoint: "http://e/ccda", roots: [] });
    expect(existsSync(path)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("loadConfig and the environment", () => {
  test("says when the environment is overriding the file", () => {
    const dir = tmp();
    const path = join(dir, "library.json");
    saveConfig(path, { endpoint: "http://e/ccda", roots: [{ dir: "/from/File", label: "File" }] });
    const cfg = loadConfig({ CCDA_SENDER_CONFIG: path, CCDA_SAMPLE_DIRS: "/from/Env" });
    expect(cfg.envOverride).toBe(true);
    expect(cfg.roots.map((r) => r.dir)).toEqual(["/from/Env"]);
    expect(loadConfig({ CCDA_SENDER_CONFIG: path }).envOverride).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("reports a config file that does not exist yet, with the path to create", () => {
    const cfg = loadConfig({ CCDA_SENDER_CONFIG: "/nonexistent/library.json" });
    expect(cfg.configExists).toBe(false);
    expect(cfg.configPath).toBe("/nonexistent/library.json");
  });
});
