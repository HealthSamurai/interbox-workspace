/**
 * Source UI — Bun server (v0.3 / step 3)
 *
 * Adds /stream/start, /stream/stop, /stream (PATCH) and /events (SSE).
 * Single + Burst from /send route also feed the shared counters so the UI
 * sees a unified throughput regardless of which mode produced traffic.
 *
 * Run:  bun run ui/server.ts   →  http://localhost:4003
 */

import { renderPage } from "./page.ts";
import { renderTopologyPage } from "./topology.ts";
import { generateAndSend, generateToFolder, folderStreamer } from "./generator.ts";
import {
  startStream, stopStream, updateStream, subscribe,
  setTarget, getTarget, bumpExternalCounters,
} from "./stream.ts";
import { ALLOWED_MSG_TYPES, SourceRegistry, type SourceType } from "./sources.ts";
import { DEFAULT_EXPORT_DIR, DEFAULT_SOURCES_PATH } from "../src/paths.ts";

const PORT = Number(process.env.PORT ?? 4003);
// Loopback by default. This server is a developer tool with no authentication:
// /export writes and (with clean:true) deletes files at a path taken straight
// from the request body, and /probe will TCP-scan from wherever it runs. Bun
// would otherwise bind 0.0.0.0 and hand all of that to anyone on the network.
// Set HOST=0.0.0.0 only on a network you control.
const HOST = process.env.HOST ?? "127.0.0.1";
const PROFILE = process.env.PROFILE_NAME ?? "default";
const SOURCES_PATH = process.env.SOURCES_PATH ?? DEFAULT_SOURCES_PATH;
const EXPORT_DIR = process.env.EXPORT_DIR ?? DEFAULT_EXPORT_DIR;

// Available MLLP targets — switchable from the UI.
// Override via TARGETS env: "label1:host1:port1,label2:host2:port2".
// Mock targets simulate ACK in-process — no real MLLP, no DB writes.
interface Target { id: string; label: string; host: string; port: number; mock?: boolean; }
const TARGETS: Target[] = parseTargets(process.env.TARGETS) ?? [
  // Real MLLP listeners on local ports. First entry → the default selected target,
  // matching the MLLP ingest port the reference docker-compose publishes.
  { id: "demo",  label: "Engine",                    host: "127.0.0.1", port: 2575 },
  { id: "alt",   label: "Engine (alt)",              host: "127.0.0.1", port: 2576 },
  // Mocked destination — generate + simulate AA, no MLLP traffic, no listener needed.
  { id: "mock",  label: "Mock target — no network",  host: "mock", port: 0, mock: true },
];

function parseTargets(spec: string | undefined): Target[] | undefined {
  if (!spec) return undefined;
  const out: Target[] = [];
  for (const chunk of spec.split(",")) {
    const [label, host, portStr] = chunk.trim().split(":");
    if (!label || !host || !portStr) continue;
    out.push({
      id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      label, host, port: Number(portStr),
    });
  }
  return out.length ? out : undefined;
}

// Pick a sensible default
let activeTargetId = TARGETS[0]?.id ?? "demo";
const initial = TARGETS.find((t) => t.id === activeTargetId)!;
setTarget(initial.host, initial.port, initial.label, initial.mock ?? false);

function activeTarget(): Target {
  return TARGETS.find((t) => t.id === activeTargetId) ?? TARGETS[0]!;
}

// Simulated upstream senders (multi-source mode) — each an independent actor.
// They default to the GLOBAL active target; a source may override its port.
const registry = new SourceRegistry(SOURCES_PATH, () => {
  const t = activeTarget();
  return { host: t.host, port: t.port, mock: t.mock ?? false };
});
await registry.init();

// Quick TCP probe for the add-source form: is anything listening on the port?
// Bun.connect resolves on open and rejects on connect failure; race a timeout.
async function probePort(port: number, host = "127.0.0.1"): Promise<boolean> {
  try {
    const sock = await Promise.race([
      Bun.connect({ hostname: host, port, socket: { data() {}, error() {}, close() {} } }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("probe timeout")), 1500)),
    ]);
    sock.end();
    return true;
  } catch {
    return false;
  }
}

interface SendBody {
  mode: "single" | "burst";
  type?: string;
  count?: number;
  faultRate?: number;
}

interface StreamStartBody { rate?: number; faultRate?: number; }
interface StreamPatchBody { rate?: number; faultRate?: number; }

Bun.serve({
  port: PORT,
  hostname: HOST,
  // SSE /events is long-lived; Bun's default 10s idleTimeout would close it
  // between ticks (heartbeat is 15s, too late to save it). 0 = no timeout.
  idleTimeout: 0,
  routes: {
    // Topology (multi-source map) is the default view; the classic
    // single-stream page stays fully functional at /classic.
    "/": () =>
      new Response(
        renderTopologyPage({ targets: TARGETS, activeTargetId, profile: PROFILE, exportDir: EXPORT_DIR }),
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
    "/classic": () => {
      const t = activeTarget();
      return new Response(
        renderPage({
          engineTarget: `${t.host}:${t.port}`,
          profile: PROFILE,
          targets: TARGETS,
          activeTargetId,
        }),
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
    "/health": () =>
      new Response(JSON.stringify({ ok: true, port: PORT, target: getTarget() }), {
        headers: { "content-type": "application/json" },
      }),
    "/targets": {
      GET: () => Response.json({ targets: TARGETS, activeId: activeTargetId }),
      POST: async (req) => {
        let body: { id?: string } = {};
        try { body = await req.json() as { id?: string }; } catch {}
        const t = TARGETS.find((x) => x.id === body.id);
        if (!t) return Response.json({ ok: false, error: "unknown target id" }, { status: 400 });
        activeTargetId = t.id;
        setTarget(t.host, t.port, t.label, t.mock ?? false);
        registry.retargetAll(); // sources without a port override follow the global target
        return Response.json({ ok: true, active: t });
      },
    },

    // ── Multi-source mode: simulated upstream senders (see sources.ts) ──
    "/sources": {
      GET: () => Response.json({ sources: registry.list() }),
      POST: async (req) => {
        let body: { name?: string; type?: SourceType; rate?: number; faultRate?: number; targetPort?: number; msgTypes?: string[] } = {};
        try { body = await req.json() as typeof body; } catch {}
        try {
          const def = await registry.create({
            name: body.name ?? "",
            type: body.type ?? "lab",
            rate: body.rate,
            faultRate: body.faultRate,
            targetPort: body.targetPort,
            msgTypes: body.msgTypes,
          });
          return Response.json({ ok: true, source: def });
        } catch (e) {
          return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
        }
      },
    },

    "/sources/:id": {
      PATCH: async (req) => {
        let body: { rate?: number; faultRate?: number; targetPort?: number; clearTargetPort?: boolean; msgTypes?: string[] } = {};
        try { body = await req.json() as typeof body; } catch {}
        try {
          const def = await registry.update(req.params.id, body);
          return Response.json({ ok: true, source: def });
        } catch (e) {
          return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
        }
      },
      DELETE: async (req) => {
        try {
          await registry.remove(req.params.id);
          return Response.json({ ok: true });
        } catch (e) {
          return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
        }
      },
    },

    // Single/burst from ONE source: its identity + mix, ACK-confirmed counts.
    "/sources/:id/send": {
      POST: async (req) => {
        const entry = registry.get(req.params.id);
        if (!entry) return Response.json({ ok: false, error: "unknown source" }, { status: 404 });
        let body: SendBody = { mode: "burst" };
        try { body = await req.json() as SendBody; } catch {}
        const count = body.mode === "single" ? 1 : Math.max(1, Math.min(10000, body.count ?? 1));
        const t = registry.targetOf(req.params.id)!;
        const result = await generateAndSend({
          count,
          faultRate: Math.max(0, Math.min(1, body.faultRate ?? entry.def.faultRate)),
          forceType: body.mode === "single" ? body.type : undefined,
          target: { host: t.host, port: t.port },
          mock: t.mock ?? false,
          profile: await registry.profileOf(req.params.id)!,
        });
        entry.actor.bump(result.sent, result.accepted, result.rejected, result.injectedFaults);
        return Response.json(result, { status: result.ok ? 200 : 502 });
      },
    },

    "/sources/:id/stream": {
      POST: async (req) => {
        const entry = registry.get(req.params.id);
        if (!entry) return Response.json({ ok: false, error: "unknown source" }, { status: 404 });
        let body: { action?: "start" | "stop"; rate?: number; faultRate?: number } = {};
        try { body = await req.json() as typeof body; } catch {}
        if (body.action === "stop") {
          entry.actor.stop();
        } else {
          // A rate/fault passed with start becomes the source's setting (persisted),
          // so the node card and the actual pacing never disagree.
          if (typeof body.rate === "number" || typeof body.faultRate === "number") {
            await registry.update(req.params.id, { rate: body.rate, faultRate: body.faultRate });
          }
          entry.actor.start(entry.def.rate, entry.def.faultRate);
        }
        registry.publishSources();
        return Response.json({ ok: true, state: entry.actor.snapshot() });
      },
    },

    // Start or stop every source at once (each at its own rate).
    "/sources/stream-all": {
      POST: async (req) => {
        let body: { action?: "start" | "stop" } = {};
        try { body = await req.json() as typeof body; } catch {}
        registry.streamAll(body.action === "stop" ? "stop" : "start");
        return Response.json({ ok: true, sources: registry.list() });
      },
    },

    // ── File export: write .hl7 files to a folder (batch) or trickle (stream) ──
    "/export": {
      GET: () => Response.json({ stream: folderStreamer.state() }),
      POST: async (req) => {
        let body: { dir?: string; count?: number; faultRate?: number; types?: string[]; clean?: boolean } = {};
        try { body = await req.json() as typeof body; } catch {}
        if (!body.dir) return Response.json({ ok: false, error: "dir is required" }, { status: 400 });
        const result = await generateToFolder({
          dir: body.dir,
          count: Math.max(1, Math.min(100000, body.count ?? 10)),
          faultRate: Math.max(0, Math.min(1, body.faultRate ?? 0)),
          types: body.types,
          clean: !!body.clean,
        });
        return Response.json(result, { status: result.ok ? 200 : 400 });
      },
    },
    "/export/stream": {
      POST: async (req) => {
        let body: { action?: "start" | "stop"; dir?: string; rate?: number; faultRate?: number; types?: string[] } = {};
        try { body = await req.json() as typeof body; } catch {}
        if (body.action === "stop") {
          folderStreamer.stop();
          return Response.json({ ok: true, stream: folderStreamer.state() });
        }
        if (!body.dir) return Response.json({ ok: false, error: "dir is required" }, { status: 400 });
        const r = await folderStreamer.start({
          dir: body.dir,
          rate: Math.max(0.1, Math.min(200, body.rate ?? 2)),
          faultRate: Math.max(0, Math.min(1, body.faultRate ?? 0)),
          types: body.types,
        });
        return Response.json({ ...r, stream: folderStreamer.state() }, { status: r.ok ? 200 : 400 });
      },
    },

    // Buildable message types (registry-derived) — the UI chips come from here,
    // so new builders appear in the picker automatically.
    "/msg-types": () => Response.json({ types: ALLOWED_MSG_TYPES }),

    // TCP probe for the add-source form: ✓ listening / ✗ refused.
    "/probe": async (req) => {
      const url = new URL(req.url);
      const port = Number(url.searchParams.get("port"));
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return Response.json({ ok: false, error: "invalid port" }, { status: 400 });
      }
      return Response.json({ port, listening: await probePort(port) });
    },

    "/send": {
      POST: async (req) => {
        let body: SendBody;
        try { body = await req.json() as SendBody; }
        catch { return Response.json({ ok: false, error: "invalid json" }, { status: 400 }); }
        const faultRate = Math.max(0, Math.min(1, body.faultRate ?? 0));
        const count = body.mode === "single" ? 1 : Math.max(1, Math.min(10000, body.count ?? 1));
        const forceType = body.mode === "single" ? body.type : undefined;
        const t = activeTarget();
        const result = await generateAndSend({
          count, faultRate, forceType,
          target: { host: t.host, port: t.port },
          mock: t.mock ?? false,
        });
        // feed shared counters — sent = written, accepted = AA, rejected = AE/AR, unanswered = silence
        bumpExternalCounters(result.sent, result.accepted, result.rejected, result.injectedFaults);
        return Response.json(result, { status: result.ok ? 200 : 502 });
      },
    },

    "/stream/start": {
      POST: async (req) => {
        let body: StreamStartBody = {};
        try { body = await req.json() as StreamStartBody; } catch {}
        startStream(body.rate ?? 3.0, body.faultRate ?? 0);
        return Response.json({ ok: true });
      },
    },

    "/stream/stop": {
      POST: () => {
        stopStream();
        return Response.json({ ok: true });
      },
    },

    "/stream": {
      PATCH: async (req) => {
        let body: StreamPatchBody = {};
        try { body = await req.json() as StreamPatchBody; } catch {}
        updateStream(body);
        return Response.json({ ok: true });
      },
    },

    "/events": (req) => {
      // SSE: client connects once on page-load, receives state + tick events
      const enc = new TextEncoder();
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const stream = new ReadableStream({
        start(controller) {
          const send = (data: unknown) => {
            try { controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`)); }
            catch { /* connection closed mid-flight */ }
          };
          unsubscribe = subscribe(send);
          heartbeat = setInterval(() => {
            try { controller.enqueue(enc.encode(`: heartbeat\n\n`)); }
            catch {}
          }, 15000);
          // disconnect when client navigates away
          req.signal.addEventListener("abort", () => {
            try { unsubscribe(); } catch {}
            if (heartbeat) clearInterval(heartbeat);
            try { controller.close(); } catch {}
          });
        },
        cancel() {
          try { unsubscribe(); } catch {}
          if (heartbeat) clearInterval(heartbeat);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          "connection": "keep-alive",
        },
      });
    },
  },
  error(err) {
    console.error("[source-ui]", err);
    return Response.json(
      { ok: false, error: (err as Error)?.message ?? String(err) },
      { status: 500 },
    );
  },
});

console.log(
  `[source-ui] listening on http://localhost:${PORT}  ·  profile ${PROFILE}`,
);
console.log(
  `[source-ui] targets: ${TARGETS.map((t) => `${t.label}@${t.host}:${t.port}`).join(" · ")}  (active: ${activeTarget().label})`,
);
