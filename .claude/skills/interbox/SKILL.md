---
name: interbox
description: Entry point for working in an interbox workspace — understanding how the engine works or reading its guide/concepts, authoring or reviewing pipelines and HL7v2→FHIR mappers, looking up HL7v2 spec (segments/fields/datatypes/tables) or FHIR R4 resource shapes, parsing or dry-running a message, triaging and resolving the error queue, querying the downstream Aidbox, or reviewing the working-tree diff. The full skill library (including the prose docs) ships with the @health-samurai/interbox SDK and is discovered at runtime — use this whenever a task touches interbox pipelines, mappers, messages, errors, docs, or the SDK.
---

# Interbox workspace skills

This workspace ships a library of task-specific skills with the
`@health-samurai/interbox` SDK. They are **not** copied into this repo — you
discover them at runtime so they always match the installed SDK version (no
stale copies, no sync step to go wrong).

## How to use them

1. List what's available:

   ```
   bun run interbox-cli assistant skills list
   ```

   It prints every skill's name, what it's for, and the **absolute path** to its
   `SKILL.md`.

2. Pick the one matching the task, **Read that `SKILL.md`, and follow it exactly**
   — each is a self-contained procedure (most drive `interbox-cli assistant …`
   subcommands).

3. No file-read tool handy? Dump one to stdout instead:

   ```
   bun run interbox-cli assistant skills cat <name>
   ```

## What's in the library

Rough map so you can jump straight to the right one — **`skills list` is
authoritative** (this may drift as the SDK adds skills):

| Task | Skill |
|------|-------|
| Explain a concept / how-and-why / setup / error model (prose guide) | `interbox-docs` |
| HL7v2 spec lookup (segment/field/datatype/table) | `interbox-hl7v2-info` |
| Parse a raw message into its segment/field tree | `interbox-hl7v2-parse` |
| Dry-run a message through the workspace mapper (offline) | `interbox-hl7v2-map` |
| FHIR R4 resource/datatype field lookup | `interbox-fhir-info` |
| Read-only FHIR query against the downstream Aidbox | `interbox-aidbox-query` |
| Triage / inspect / resolve the error queue | `interbox-check-errors` |
| Show what changed in the workspace (rendered diff) | `interbox-diff` |
| SDK API reference — exact export shapes (pipeline DSL, builtins, mappers) | `interbox-reference` |
| Upgrade the SDK to a newer version (careful — explicit request only) | `interbox-upgrade` |

If nothing above fits, run `skills list` and read the descriptions — they say
exactly when each applies.
