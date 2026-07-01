# interbox-workspace

Pipeline definitions for the Interbox engine. The engine has no built-in
topology — it loads the pipelines declared here at boot.

Pipelines are authored against [`@healthsamurai/interbox`](https://github.com/HealthSamurai/interbox).
A pipeline wires the engine's built-in stages (`source → mapper → sender`) by
`type` string + config; the engine owns the implementations. Secrets and
deployment values are referenced with `env()` and resolved from the engine's
environment, so definitions stay portable and secret-free.

```ts
import { env, pipeline } from "@healthsamurai/interbox";

pipeline("hl7-to-aidbox")
  .source({ id: "mllp-default", type: "mllp", config: { /* … */ } })
  .mapper({ type: "v2-to-fhir", config: {} })
  .sender({ type: "aidbox", config: { /* … */ } });
```

`src/index.ts` imports every pipeline module (for its registration side effect)
and re-exports the registry the engine reads back:

```ts
import "./pipelines";
export { PipelineRegistry } from "@healthsamurai/interbox";
```

## How the engine loads it

The engine takes a single `INTERBOX_WORKSPACE_GIT_URL`, builds `src/index.ts` into
one self-contained bundle, and imports that:

- **remote** (`git@…`, `https://…`, `ssh://…`) — deploy. Clones the repo and
  `bun install`s it. `INTERBOX_WORKSPACE_GIT_KEY` supplies a token for private
  https; `INTERBOX_WORKSPACE_GIT_REF` picks the branch.
- **local** — a `file://` URL (or bare path) to a checkout. Bundles the **live
  working tree** in place (uncommitted edits included), with no clone or install,
  for a fast edit → restart loop. The checkout must already have its deps
  installed.

### Authenticate — one GitHub token

`@healthsamurai/interbox` is a **private** package on GitHub Packages, and the
interbox image can be pulled privately from GHCR. A single GitHub token with the
**`read:packages`** scope covers both. Issue one with the scope pre-selected:

> https://github.com/settings/tokens/new?description=Interbox+workspace&scopes=read:packages

Export it, then install (the `.npmrc` here reads `GITHUB_TOKEN`):

```bash
export GITHUB_TOKEN=ghp_xxx   # read:packages
bun install
```

If the image is private, log Docker into GHCR once with the same token (the
daemon can't read the token at pull time, so this step is separate):

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GH_USERNAME --password-stdin
```

For the compose stack, put `GITHUB_TOKEN` in `.env` instead — compose passes it
into the container for the in-image SDK install.

Pipelines load once at engine boot; restart the engine to pick up changes.

## Develop

```bash
bun install
bun run typecheck
bun run bundle
```
