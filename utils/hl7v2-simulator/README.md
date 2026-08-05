# HL7v2 simulator

Synthetic HL7v2 traffic for testing an Interbox pipeline end to end — ADT, ORU,
SIU, MDM, RDE and RAS, generated from a statistical profile and pushed over MLLP.

It is a **multi-source** simulator: it runs several independent upstream senders
at once, each with its own pace, its own TCP connection, its own MSH identity and
its own MRN pool. Downstream, they are indistinguishable from distinct real
systems — which is what you need to exercise routing, patient matching and
per-source error handling rather than a single well-behaved firehose.

No real data is involved. Content is synthesized from aggregate distributions
plus faker-generated identities; the bundled profile ships with the repo.

> **Not part of the root install.** This is a self-contained package with its own
> `package.json` and lockfile, so a workspace that never uses the simulator
> doesn't carry its dependencies. Install it separately, as shown below.

## Quick start

You need [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).

From the workspace root, with the dev stack already up (`docker compose up`):

```bash
bun run simulator
```

That installs the simulator's dependencies and starts its UI on
**http://localhost:4003**. Open it, click **Start all**, and watch messages
arrive in the Interbox dashboard at http://localhost:3001.

The equivalent long form, if you prefer to work inside this directory:

```bash
cd utils/hl7v2-simulator
bun install
bun run ui
```

The default target is `127.0.0.1:2575` — the MLLP port the workspace's
`docker-compose.yaml` publishes, so out of the box the simulator points at your
local engine with no configuration.

## Point it at a target

The UI's target selector switches between the configured MLLP targets. Three
ship by default:

| Target | Address | What |
| --- | --- | --- |
| **Engine** | `127.0.0.1:2575` | the workspace dev stack (default) |
| **Engine (alt)** | `127.0.0.1:2576` | a second local listener |
| **Mock target** | — | ACKs in-process; no network, no listener needed |

Use **Mock target** to exercise the generator and watch the UI without anything
listening — useful for a first look, or for generating a corpus offline.

Override the list with `TARGETS`, a comma-separated `label:host:port`:

```bash
TARGETS="Staging:hl7.internal:2575,Local:127.0.0.1:2575" bun run ui
```

The first entry becomes the default selection. Individual sources can override
just the port (see the inspector panel, or `targetPort` below) while sharing the
selected host — handy when one pipeline listens on its own port.

Other environment knobs:

| Variable | Default | What |
| --- | --- | --- |
| `PORT` | `4003` | port the simulator UI listens on |
| `HOST` | `127.0.0.1` | interface the UI binds to — see the warning below |
| `TARGETS` | the three above | MLLP targets, `label:host:port,…` |
| `PROFILE_PATH` | this package's `fixtures/profile.json` | generator profile |
| `PROFILE_NAME` | `default` | profile label shown in the UI |
| `SOURCES_PATH` | this package's `data/sources.json` | where source definitions persist |
| `EXPORT_DIR` | this package's `batch-out/` | directory prefilled in the export form |
| `MAX_STREAM_RATE` | `1000` | per-source msg/s ceiling |
| `RECEIVING_APP` / `RECEIVING_FACILITY` | `INTERBOX` | MSH-5 / MSH-6 on generated messages |

Path defaults resolve inside this package, so the simulator behaves the same
whether you start it from here or from the workspace root. A path you pass
explicitly is used as given — a relative one resolves against your shell's
working directory, as usual.

> **Bind address.** The simulator listens on loopback only, because it has no
> authentication of any kind: `/export` writes — and with `clean: true`, deletes
> — files at a path taken straight from the request body, and `/probe` opens TCP
> connections on request. Setting `HOST=0.0.0.0` hands those to anyone who can
> reach the port. Do it only on a network you control, and never on a shared or
> internet-facing host.

## Choose source types

A source is a persisted definition driven by its own actor:

```ts
SourceDef { id, name, type, rate, faultRate, targetPort?, msgTypes? }
```

`type` picks the sending application (MSH-3) and the message mix:

| Type | MSH-3 | Message mix |
| --- | --- | --- |
| `lab` | `LAB_IF` | ORU^R01 75% · ORM^O01 10% · ADT^A08 15% |
| `clinic` | `CLINIC_EHR` | ADT^A08 55% · SIU^S12 45% |
| `hospital` | `HOSP_ADT` | ADT^A01 30% · ADT^A03 20% · ADT^A08 20% · ORU^R01 20% · MDM^T02 10% |
| `pharmacy` | `PHARM_SYS` | RDE^O11 50% · RAS^O17 35% · ADT^A08 15% |

Add one in the UI with **Add source** — name it, pick a type, set `rate`
(messages per second) and `faultRate` (0–1, the fraction deliberately corrupted).
Or over HTTP:

```bash
curl -X POST localhost:4003/sources \
  -H 'content-type: application/json' \
  -d '{"name":"Sunrise Lab","type":"lab","rate":5,"faultRate":0.05}'
```

To override the preset mix, pass `msgTypes` — an explicit, equally weighted set
drawn from `ORU^R01`, `ORM^O01`, `ADT^A01`, `ADT^A03`, `ADT^A08`, `SIU^S12`,
`MDM^T02`, `MDM^T07`, `MDM^T11`, `RDE^O01`, `RDE^O11`, `RAS^O17`:

```bash
curl -X POST localhost:4003/sources \
  -H 'content-type: application/json' \
  -d '{"name":"ADT Only","type":"hospital","rate":2,"faultRate":0,
       "msgTypes":["ADT^A01","ADT^A03"]}'
```

**Identity.** Each source stamps its own MSH-3 (sending application) and MSH-4
(sending facility, from the name) and draws MRNs from its own pool under its own
assigning authority.

**Isolation.** Every source gets its own Poisson loop, its own TCP socket and its
own seeded RNG, so streams interleave on the wire and one source failing does not
disturb the others. Fault injection is per-source via `faultRate`.

## Faults

`faultRate` is the fraction of messages deliberately broken before sending —
truncated segments, bad field counts, unparseable timestamps and the like. The
simulator classifies each locally, so its summary previews how the engine will
bucket them (`parse_error` / `map_error` / `data_quality`, or benign-but-valid).
Set it to `0` for a clean stream, or crank it to see the dashboard's error views
populate.

## The two views

| Route | View |
| --- | --- |
| `/` | **Topology** — sources around the engine hub, live traffic as moving dots, per-source inspector |
| `/classic` | Single stream — EKG-style waveform, one generator, one target |

> `/classic` loads Alpine.js and Geist from public CDNs, so it needs internet.
> The default topology view at `/` is fully self-contained and works offline.

## CLI

The UI is optional — the generator and sender are usable on their own.

```bash
# Generate and inspect (count, faultRate, seed)
bun run gen 1000 0.05 42

# Write a corpus: out.jsonl / out.csv, or one .hl7 file per message
bun run gen 1000 0.05 42 --output jsonl
bun run gen 500 0 42 --out-dir ./corpus --clean
bun run gen 200 0 42 --types ADT^A01,ORU^R01   # force an even mix

# Send over MLLP to a running engine
bun run send batch --count 500 --months 3    # fixed count, MSH-7 spread over 3 months
bun run send stream --rate 20 --poisson      # paced live stream until Ctrl-C
bun run send <mode> --help                   # per-mode flags

bun run selftest    # generate and validate against the real parser
bun test
bun run typecheck
```

`--out-dir` writes CR-separated `.hl7` files with no MLLP framing — the shape a
folder source ingests, for testing that path without a socket.

## HTTP API

| Method | Path | What |
| --- | --- | --- |
| GET · POST | `/sources` | list · create |
| PATCH · DELETE | `/sources/:id` | update · remove |
| POST | `/sources/:id/send` | one-off send from this source |
| POST | `/sources/:id/stream` | start / stop this source |
| POST | `/sources/stream-all` | start / stop every source |
| GET | `/events` | SSE — per-send ticks and counters |
| GET | `/msg-types` | message types available for hand-picking |
| GET | `/probe?port=N` | TCP reachability check for a target port |
| GET · POST | `/export` | folder-streamer state · write `.hl7` files to a directory |
| POST | `/export/stream` | start / stop trickling `.hl7` files into a directory |
| GET · POST | `/targets` | list configured targets · switch the active one |
| POST · PATCH | `/send`, `/stream/start`, `/stream/stop`, `/stream` | single-stream API behind `/classic` |
| GET | `/health` | liveness + active target |

## What's where

| Path | What |
| --- | --- |
| `ui/server.ts` | Bun.serve — the routes above |
| `ui/topology.ts` | Topology view — hub, source nodes, flow curves, inspector |
| `ui/sources.ts` | `SourceRegistry` — definitions, presets, persistence |
| `ui/actor.ts` | `SourceActor` — per-source loop, socket, counters |
| `ui/bus.ts` | SSE pub/sub |
| `ui/page.ts` | Classic single-stream page |
| `ui/generator.ts` | Thin wrapper around `src/gen/*` + `src/send/mllp.ts` |
| `ui/stream.ts` | Server-side Poisson loop for the classic view |
| `src/cli.ts` | CLI generator (`bun run gen`) |
| `src/send-cli.ts` | MLLP sender CLI, `batch` / `stream` (`bun run send`) |
| `src/gen/` | Message synthesis (profile-driven, no real data) |
| `src/send/mllp.ts` | MLLP transport — fire-and-forget, reliable (ACK-aware), live stream |
| `src/paths.ts` | Package-relative defaults for profile / state / export paths |
| `fixtures/` | `profile.json` (the shipped generator profile) and `profile.example.json` (a smaller one used by the tests) |
| `test/` | Unit tests, incl. `sources.test.ts` for the registry |
