/**
 * The sender's server half.
 *
 * It exists for three reasons the browser cannot cover on its own: it reads the
 * sample directories, it does the parsing and the sanitizing in one auditable
 * place, and it makes the POST to the engine — which keeps a cross-origin
 * request out of the picture and lets a 12 MB document stream off disk instead
 * of through the page.
 *
 * Run:  bun run ui/server.ts   →  http://localhost:4004
 */

import { renderPage } from "./page.ts";
import { loadConfig, saveConfig, basename, type LibraryRoot } from "../src/config.ts";
import { scanLibrary, findSample, formatBytes, probeDirectory, listDirectory, normalizeDir, type Library } from "../src/library.ts";
import { parseHeader, formatHl7Time } from "../src/cda/header.ts";
import { parseSections } from "../src/cda/narrative.ts";
import { highlightSlice } from "../src/cda/highlight.ts";
import { sendDocument, sendBytes } from "../src/send.ts";
import { pkgPath } from "../src/paths.ts";
import { decodeDocument } from "../src/decode.ts";
import { file } from "bun";

// 400x is where the workspace keeps its developer tools; the stands' own ports
// all end in 0, so nothing here can grow into a stand's slot.
const PORT = Number(process.env.PORT ?? 4004);

// Loopback by default. This server has no authentication, it reads files from
// directories the operator configured, and /send will POST from wherever it
// runs. Bun would otherwise bind every interface and hand all of that to the
// network. `||`, not `??`: an empty-but-set HOST reaches Bun as hostname:"" and
// binds the wildcard while still reporting itself as localhost.
const HOST = process.env.HOST || "127.0.0.1";
/** Only these reach nobody but this machine. Any other value — a wildcard, a LAN
 *  address, an IPv6 spelling of zero — puts the server on the network, and the
 *  startup line has to say so rather than print a URL that looks reassuring. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const EXPOSED = !LOOPBACK.has(HOST);

/** First screen of XML. The rest is fetched only if the reader asks for it. */
const XML_LINES = 400;
/** A dropped file larger than this is refused rather than read into memory. */
const MAX_UPLOAD = 32 * 1024 * 1024;

let config = loadConfig();
let library: Library = scanLibrary(config.roots);

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const problem = (message: string, status: number): Response => new Response(message, { status });

interface DocumentView {
  name: string;
  size: string;
  header: ReturnType<typeof describeHeader>;
  sections: ReturnType<typeof parseSections>["sections"];
  sectionsTruncated: boolean;
  xml: ReturnType<typeof highlightSlice>;
}

function describeHeader(xml: string) {
  const h = parseHeader(xml);
  return {
    title: h.title,
    patientName: h.patientName,
    mrn: h.mrn,
    documentId: h.documentId,
    effectiveTime: formatHl7Time(h.effectiveTime),
    birthTime: formatHl7Time(h.birthTime),
    sex: h.sex,
    custodian: h.custodian,
    isClinicalDocument: h.isClinicalDocument,
  };
}

function buildView(name: string, xml: string, lines: number, raw = false, sizeBytes?: number): DocumentView {
  const scan = parseSections(xml);
  return {
    name,
    // The size on disk when it is known. Measuring the decoded string instead
    // disagrees with the same document's size in the library list: a BOM
    // disappears, and every accented character in a single-byte encoding gains
    // a byte on the way in.
    size: formatBytes(sizeBytes ?? Buffer.byteLength(xml, "utf8")),
    header: describeHeader(xml),
    sections: scan.sections,
    sectionsTruncated: scan.truncated,
    xml: highlightSlice(xml, lines, raw),
  };
}

/** The configuration as the settings panel needs it. */
const configPayload = () => ({
  roots: config.roots,
  endpoint: config.endpoint,
  configPath: config.configPath,
  configExists: config.configExists,
  envOverride: config.envOverride,
  problem: config.problem,
});

/** The library as the page needs it — paths stay on the server. */
const libraryPayload = (lib: Library) => ({
  total: lib.total,
  scanMs: lib.scanMs,
  groups: lib.groups.map((g) => ({
    label: g.label,
    dir: g.dir,
    error: g.error,
    samples: g.samples.map((s) => ({
      id: s.id,
      file: s.file,
      size: formatBytes(s.bytes),
      patientName: s.patientName,
      title: s.title,
      date: s.date,
      custodian: s.custodian,
      isClinicalDocument: s.isClinicalDocument,
    })),
  })),
});

/** Parse a JSON body, or answer 400. `req.json()` throws on anything that is not
 *  JSON, and the browser picks the branch by a content-type it derived from the
 *  dropped file — so this is reachable with an ordinary file, not only by hand. */
async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") return problem("Expected a JSON object.", 400);
    return body as Record<string, unknown>;
  } catch {
    return problem("Expected a JSON body.", 400);
  }
}

async function readBody(req: Request): Promise<string | Response> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_UPLOAD) return problem(`That file is larger than ${formatBytes(MAX_UPLOAD)}.`, 413);
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_UPLOAD) return problem(`That file is larger than ${formatBytes(MAX_UPLOAD)}.`, 413);
  return decodeDocument(buf);
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  // A 12 MB document takes real time to reach a slow receiver.
  idleTimeout: 120,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" && req.method === "GET") {
      return new Response(renderPage({
        bootstrap: {
          config: configPayload(),
          library: libraryPayload(library),
        },
      }), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (path === "/app.css" && req.method === "GET") {
      return new Response(file(pkgPath("ui", "client", "app.css")), { headers: { "Content-Type": "text/css; charset=utf-8" } });
    }
    if (path === "/app.js" && req.method === "GET") {
      return new Response(file(pkgPath("ui", "client", "app.js")), { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    }

    if (path === "/api/library") {
      if (req.method === "POST") library = scanLibrary(config.roots);
      return json(libraryPayload(library));
    }

    // --- Library settings ---------------------------------------------------
    //
    // These let the page change which folders are listed, which is the one
    // thing this tool otherwise makes you leave the window to do. They also
    // make the server a "does this folder exist, and how many documents are in
    // it" oracle for any path the caller names, and let it write one file. That
    // is acceptable here for the same reason the rest of the surface is: the
    // server binds loopback and is a developer tool on the operator's own
    // machine. It is not acceptable anywhere else — see the HOST note above.

    if (path === "/api/config" && req.method === "GET") {
      return json(configPayload());
    }

    if (path === "/api/config/probe" && req.method === "POST") {
      const body = await readJson(req);
      if (body instanceof Response) return body;
      if (typeof body.dir !== "string") return problem("dir must be a string.", 400);
      return json(probeDirectory(body.dir));
    }

    if (path === "/api/config/browse" && req.method === "POST") {
      const body = await readJson(req);
      if (body instanceof Response) return body;
      return json(listDirectory(typeof body.dir === "string" ? body.dir : ""));
    }

    if (path === "/api/config" && req.method === "PUT") {
      const body = await readJson(req);
      if (body instanceof Response) return body;
      if (!Array.isArray(body.roots)) return problem("roots must be a list.", 400);

      const roots: LibraryRoot[] = [];
      for (const entry of body.roots) {
        if (!entry || typeof entry !== "object") continue;
        const raw = (entry as { dir?: unknown }).dir;
        if (typeof raw !== "string") continue;
        const dir = normalizeDir(raw);
        if (dir === "") continue;
        const givenLabel = (entry as { label?: unknown }).label;
        const label = typeof givenLabel === "string" && givenLabel.trim() !== ""
          ? givenLabel.trim().slice(0, 60)
          : basename(dir);
        roots.push({ dir, label });
      }

      // What the file already said, unless this request names an endpoint. The
      // effective `config.endpoint` may have come from CCDA_URL, and writing that
      // back would bake a one-off run's address into the file the next time
      // anyone saves a folder.
      const given = body.endpoint;
      const endpoint = typeof given === "string" && given.trim() !== ""
        ? given.trim()
        : config.fileEndpoint ?? config.endpoint;

      try {
        saveConfig(config.configPath, { roots, endpoint });
      } catch (err) {
        return problem(`Could not write ${config.configPath}: ${(err as Error).message}`, 500);
      }

      // Re-read rather than patching what is in memory, so what the window
      // shows next is what the file now says — including the environment still
      // winning if it is set.
      config = loadConfig();
      library = scanLibrary(config.roots);
      return json({ config: configPayload(), library: libraryPayload(library) });
    }

    if (path.startsWith("/api/document/") && req.method === "GET") {
      const id = decodeURIComponent(path.slice("/api/document/".length));
      const sample = findSample(library, id);
      if (!sample) return problem("No such document in the library. Rescan and try again.", 404);
      // Clamped at both ends. Without a floor, `?lines=-1` reaches takeLines,
      // which then never finds a cut and returns the whole document — twelve
      // megabytes of it in this corpus, highlighted in full.
      const asked = Math.floor(Number(url.searchParams.get("lines") ?? XML_LINES)) || XML_LINES;
      const lines = Math.min(Math.max(1, asked), 200_000);
      let xml: string;
      try {
        xml = decodeDocument(await file(sample.path).arrayBuffer());
      } catch (err) {
        return problem(`${sample.file} could not be read: ${(err as Error).message}`, 500);
      }
      return json(buildView(sample.file, xml, lines, url.searchParams.get("raw") === "1"));
    }

    if (path === "/api/preview" && req.method === "POST") {
      const body = await readBody(req);
      if (body instanceof Response) return body;
      const name = url.searchParams.get("name") ?? "dropped document";
      return json(buildView(name, body, XML_LINES));
    }

    if (path === "/api/send" && req.method === "POST") {
      // Two shapes: a library document by id, or a dropped file's bytes.
      const contentType = req.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const parsed = await readJson(req);
        if (parsed instanceof Response) return parsed;
        const body = parsed as { id?: string; endpoint?: string };
        const sample = body.id ? findSample(library, body.id) : null;
        if (!sample) return problem("No such document in the library.", 404);
        const target = body.endpoint?.trim() || config.endpoint;
        return json(await sendDocument(sample.path, target, { name: sample.file }));
      }

      const target = url.searchParams.get("endpoint")?.trim() || config.endpoint;
      const bytes = await req.arrayBuffer();
      if (bytes.byteLength > MAX_UPLOAD) return problem(`That file is larger than ${formatBytes(MAX_UPLOAD)}.`, 413);
      // The receiver would answer 400 for an empty body, which costs a round trip
      // and writes a misleading line into the run log. Refuse it here.
      if (bytes.byteLength === 0) return problem("Nothing to send: the request carried no document.", 400);
      // Through the same sender as a library document: a dropped file is not a
      // different kind of send, and a second copy of the request here would be a
      // second place for the two receiver shapes to drift apart.
      const name = url.searchParams.get("name") ?? undefined;
      return json(await sendBytes(bytes, target, { name }));
    }

    return problem("Not found", 404);
  },
});

const where = `http://${EXPOSED ? HOST : "localhost"}:${server.port}`;
console.log(`C-CDA Sender  ${where}`);
console.log(`  endpoint    ${config.endpoint}`);
console.log(`  library     ${library.total} documents in ${library.groups.length} group(s), scanned in ${Math.round(library.scanMs)} ms`);
for (const g of library.groups) {
  console.log(`              ${g.label.padEnd(14)} ${g.error ? `— ${g.error}` : `${g.samples.length} documents`}  ${g.dir}`);
}
console.log(`  settings    ${config.configPath}${config.configExists ? "" : " (not created yet)"}`);
if (config.envOverride) console.log(`  note        CCDA_SAMPLE_DIRS is set, so it wins over that file`);
if (config.problem) console.log(`  note        ${config.problem}`);
if (EXPOSED) {
  console.log(`  WARNING     HOST=${HOST} reaches the network. This server has no login and reads`);
  console.log(`              the configured folders for anyone who can open it.`);
}
