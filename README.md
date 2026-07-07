# interbox-workspace

[![npm version](https://img.shields.io/npm/v/@health-samurai/interbox?logo=npm)](https://www.npmjs.com/package/@health-samurai/interbox)
[![Docker version](https://img.shields.io/docker/v/healthsamurai/interbox?sort=semver&label=docker&logo=docker&logoColor=white)](https://hub.docker.com/r/healthsamurai/interbox)
[![Helm chart](https://img.shields.io/badge/Helm-chart-0F1689?logo=helm&logoColor=white)](https://github.com/HealthSamurai/helm-charts/tree/main/interbox)
[![CI](https://img.shields.io/github/actions/workflow/status/HealthSamurai/interbox-workspace/ci.yml?branch=main&logo=github&logoColor=white&label=CI)](https://github.com/HealthSamurai/interbox-workspace/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-mdBook-blue)](https://healthsamurai.github.io/interbox-workspace/)

Reference pipeline for [Interbox](https://www.health-samurai.io/interbox), an
extensible integration engine. Fork this repo, adjust the pipeline for your
own data, and deploy.

## Quick start

```bash
cp .env.example .env   # fill in the license — see that file for options
docker compose up
```

Open http://localhost:3001 for the dashboard. The image is **licensed**: the
pipeline stays paused until you set `INTERBOX_LICENSE` in `.env`, or activate
through the dashboard itself (portal OAuth) — until then you'll see an
activation screen there.

Send HL7v2 over MLLP to `localhost:2575` and watch messages flow through to
the FHIR server.

## Configure the dashboard assistant

The dashboard's assistant is a Claude Code agent running **inside the container**,
which has no `~/.claude` of its own — so you hand it credentials through `.env`.
It's optional: leave everything blank and the dashboard still works, the assistant
just shows a "no credentials" banner instead of answering. Pick one path:

| Path | Set in `.env` | Billing |
| --- | --- | --- |
| **Subscription token** (any OS) | `CLAUDE_CODE_OAUTH_TOKEN` — run `claude setup-token` on the host (macOS: `./scripts/setup-claude-mac.sh` does it for you) | Claude Pro/Max subscription |
| **API key** | `ANTHROPIC_API_KEY=sk-ant-…` | Pay-per-token |
| **Reuse host login** (Linux/Windows dev) | `CLAUDE_CONFIG_DIR=${HOME}/.claude` — bind-mounts your existing login into the container | Your existing session |

Notes:

- **macOS** keeps Claude Code creds in the **Keychain**, not in a file, so the
  reuse-host-login path can't work there — use the subscription token instead
  (`./scripts/setup-claude-mac.sh` mints one; needs the Claude Code CLI + a
  Pro/Max plan).
- The reuse-host-login path is `.env`-driven — no `docker-compose.yaml` edit.
  Left unset, `CLAUDE_CONFIG_DIR` defaults to an empty managed volume, so nothing
  from your host is exposed.

## Author pipelines

Pipeline definitions for the Interbox engine. The engine has no built-in
topology — it loads the pipelines declared here at boot.

Pipelines are authored against [`@health-samurai/interbox`](https://www.npmjs.com/package/@health-samurai/interbox).
A pipeline wires the engine's built-in stages (`source → mapper → sender`) by
`type` string + config; the engine owns the implementations. Secrets and
deployment values are referenced with `env()` and resolved from the engine's
environment, so definitions stay portable and secret-free.

```ts
import { env, pipeline } from "@health-samurai/interbox";

pipeline("hl7-to-aidbox")
  .source({ id: "mllp-default", type: "mllp", config: { /* … */ } })
  .mapper({ type: "v2-to-fhir", config: {} })
  .sender({ type: "aidbox", config: { /* … */ } });
```

`src/index.ts` imports every pipeline module (for its registration side effect)
and re-exports the registry the engine reads back:

```ts
import "./pipelines";
export { PipelineRegistry } from "@health-samurai/interbox";
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

Pipelines load once at engine boot; restart the engine to pick up changes.

## Develop

```bash
bun install
bun run typecheck
bun run bundle
```
