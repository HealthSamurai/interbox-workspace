# C-CDA Sender

Reads clinical documents and pushes them into the integration engine.

Point it at one or more directories of C-CDA files and it lists them, shows what
each one says, and POSTs the ones you choose to the engine's `ccda-http` source.
A send shows up on the dashboard's Documents page within a few seconds.

```
bun run ccda:sender          # from the workspace root
```

Then open http://localhost:4004.

## Configuration

Sample directories have no default. The quickest way to set them is **Library
settings**, in the top right of the window. Either paste a path, or press
**Browse…** and click your way there: each folder is listed with the number of
documents in it, so you can see which level actually holds them before you
commit. Your choice is saved to `data/library.json` and the library rescans.

That file is plain JSON — `fixtures/library.example.json` is a copy to start
from — so editing it by hand works just as well. For a one-off run:

```
CCDA_SAMPLE_DIRS=/path/to/one:/path/to/another bun run ccda:sender
```

The environment wins over the file. When it is set, the window says so rather
than letting settings look as though they had no effect.

| Variable | Default | |
|---|---|---|
| `CCDA_SAMPLE_DIRS` | — | Directories to list, separated by `:` or `,` |
| `CCDA_SENDER_CONFIG` | `data/library.json` | Where the configuration is read from |
| `CCDA_URL` | `http://localhost:2880/ccda` | The receiver. Editable in the window too |
| `PORT` | `4004` | |
| `HOST` | `127.0.0.1` | Loopback. See the note in `ui/server.ts` before changing it |

A group's heading is its directory's name. To show something else, type over it
in Library settings, or give the entry a `label` in the file. The name stays
local either way, and documents themselves are never committed.

## The window

**Library.** Every document, grouped by directory. Each row leads with the
document's type, then the two things that actually differ between exports: when
it was written and which site wrote it.

Tabs under the search box narrow the list to one folder — click the same tab
again for all of them. The text filter applies on top, and the arrow keys walk
whatever is left. `↑` `↓` move, `Enter` sends.

**The document.** Its header, then the clinical content two ways:

- *Narrative* — the section text the sending system rendered for a clinician,
  with each section's LOINC code in the margin. Tables, lists and emphasis come
  through as the document asked for them.
- *XML* — the markup, highlighted and numbered. Most real exports are written as
  a single line, some of them megabytes long; those are re-indented for reading
  and labeled as such, with the raw file one button away.

Drop a file anywhere on the page to read it without adding it to the library.

**Settings.** Which folders are listed, edited in the window — paste a path or
browse for one. Each folder in the browser shows how many documents are in it,
and a folder with documents only one level down says so, so you can tell when
you are a level too high. Nothing changes until you press Save, so a mistyped
path cannot empty the library you are using.

A folder is read one level deep: documents in subfolders are not listed.

**Send.** One document, or every document in the group. The run log keeps the
newest first with the status, the round trip, and — when you open a row — the
receiver's answer.

## Where documents are sent

Two receivers, told apart by the address:

```
http://localhost:3180/api/sources/<source>/ingest    the engine's own ingest route
http://localhost:2880/ccda                           a workspace's own HTTP source
```

An address ending in `/api/sources/<source>/ingest` is answered in the shape that
route expects — the document as JSON, tagged `ccda`. Anything else takes the
document as a raw body with `Content-Type: application/xml`, and carries the
filename and `X-Sender` so the receiver can record what arrived and from where.

The ingest route works against a stock engine, which ships `ccdaParser` and the
`ccda_in` table as built-ins and reads the `format` field from the body. A raw
`/ccda` address needs a workspace that declares an HTTP source of its own.

## Reading the result

The ingest route answers `200` with a tally of what it took:

```
{"ingested": 1, "received": 1, "errored": 0, "skipped": 0}
```

A raw `/ccda` receiver answers `202 {"accepted": true}`. Either way the answer
covers the queuing, not the conversion: a document that fails to convert becomes
an error row for the operator, so this tool reports what the transport did and
leaves the verdict to the Documents page.

## From the terminal

For pushing a whole directory through and seeing what the engine makes of it:

```
bun run send                              # everything
bun run send -- --group Samples --limit 10   # part of it
bun run send -- --pause 250               # gentler on the receiver
```

## Layout

```
src/xml/scan.ts        a cursor over XML markup — pull one token, stop early
src/cda/header.ts      who the document is about, what it is, when
src/cda/narrative.ts   section text → HTML, by allow-list (this is the sanitizer)
src/cda/highlight.ts   syntax highlighting, line budget, re-indenting
src/config.ts          which folders and which endpoint — read and written
src/library.ts         the directories, scanned, described and probed
src/send.ts            the POST
src/send-cli.ts        the terminal front end
ui/server.ts           routes
ui/page.ts             the page shell — structure only, no document text
ui/client/             the browser half: plain DOM, no framework, no build step
```

Documents are addressed by an id the scan hands out, never by a path from the
request, so a filename in a URL cannot reach a file the scan did not find.

`bun test` covers the parsing, the sanitizing and the sending.
