# interbox-workspace

[![npm version](https://img.shields.io/npm/v/@health-samurai/interbox?logo=npm)](https://www.npmjs.com/package/@health-samurai/interbox)
[![Docker version](https://img.shields.io/docker/v/healthsamurai/interbox?sort=semver&label=docker&logo=docker&logoColor=white)](https://hub.docker.com/r/healthsamurai/interbox)
[![Helm chart](https://img.shields.io/badge/Helm-chart-0F1689?logo=helm&logoColor=white)](https://github.com/HealthSamurai/helm-charts/tree/main/interbox)
[![CI](https://img.shields.io/github/actions/workflow/status/HealthSamurai/interbox-workspace/ci.yml?branch=main&logo=github&logoColor=white&label=CI)](https://github.com/HealthSamurai/interbox-workspace/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-health--samurai.io-blue)](https://www.health-samurai.io/docs/interbox)

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

## Send test traffic

If you don't have a real upstream to point at it yet, the bundled HL7v2
simulator generates synthetic traffic (ADT / ORU / SIU / MDM / RDE / RAS) from
several independent sources at once — each with its own pace, MSH identity and
MRN pool, so routing and per-source error handling get exercised rather than a
single uniform stream. With the stack up:

```bash
bun run hl7v2:simulator
```

That installs the simulator and opens its UI on http://localhost:4003, already
pointed at the MLLP port compose publishes. Click **Start all** and watch
messages land in the dashboard.

See [`utils/hl7v2-simulator/`](utils/hl7v2-simulator/) for targets, source types,
fault injection, and the generator CLI. It's a self-contained package with its own
dependencies — deliberately outside the root install, so it costs you nothing if
you never use it.

## Edit pipelines from the dashboard

The dashboard's **Repository** tab browses this checkout. It can also edit it —
saving straight into the directory compose mounts, which the engine picks up
within two seconds, so the loop is edit → save → running.

`INTERBOX_WORKSPACE_ACCESS=apply` in `.env` is what turns that on, and
`.env.example` already sets it — so the Quick start above is all it takes. Skip
the `.env` and the engine falls back to `read` (browse only) and the editor does
not appear. Worth knowing what `apply` grants before you run this
somewhere shared: the dashboard has no login of its own, and compose publishes
3001 on every interface, so anyone who can open it can change the code this
engine runs.

Edits live in your browser until you press **Save**, and committing what you
saved stays yours to do, in your own git. A deployment works the other way round:
the engine owns a clone, so the dashboard commits and pushes a branch instead —
see **The Workspace** in the
[docs](https://www.health-samurai.io/docs/interbox) for both, and for what each
access level allows.

## Deploy on Kubernetes

For a cluster deployment with the dashboard properly secured — internal ingress,
TLS, and an SSO login gate (the dashboard has no built-in auth) — see
[`k8s/`](k8s/):

- [`k8s/k3d/`](k8s/k3d/) — a **runnable, one-command** reference on
  [k3d](https://k3d.io) (local). Stands up the full secure stack (ingress-nginx +
  cert-manager + oauth2-proxy + Dex) so you can see it work before a real cluster.
- [`k8s/aks/`](k8s/aks/) — **production templates** for AKS (internal LB,
  cert-manager DNS-01 / internal CA, Entra ID SSO, managed Postgres).

The Interbox Helm chart itself lives in
[HealthSamurai/helm-charts](https://github.com/HealthSamurai/helm-charts/tree/main/interbox).

## Configure the dashboard assistant

The dashboard's assistant is a Claude Code agent running **inside the container**,
which has no `~/.claude` of its own — so you hand it credentials through `.env`.
It's optional: clear all three and the dashboard still works, the assistant just
shows a "no credentials" banner instead of answering.

| Path | Set in `.env` | Billing |
| --- | --- | --- |
| **Reuse host login** (default; Linux/Windows dev) | `CLAUDE_CONFIG_DIR=${HOME}/.claude` — bind-mounts your existing login into the container | Your existing session |
| **Subscription token** (any OS) | `CLAUDE_CODE_OAUTH_TOKEN` — run `claude setup-token` on the host (macOS: `./scripts/setup-claude-mac.sh` does it for you) | Claude Pro/Max subscription |
| **API key** | `ANTHROPIC_API_KEY=sk-ant-…` | Pay-per-token |

Notes:

- `.env.example` ships the **reuse host login** path enabled, so a fresh copy
  works on a host that already has Claude Code. It is `.env`-driven — no
  `docker-compose.yaml` edit.
- That mount hands the container the **whole** config dir: your Claude settings,
  your session transcripts under `projects/`, and any MCP OAuth tokens the login
  file carries. Comment `CLAUDE_CONFIG_DIR` out to expose nothing — it then falls
  back to an empty managed volume — and use a token or API key instead.
- A token or API key **outranks** the mounted login, so a leftover
  `CLAUDE_CODE_OAUTH_TOKEN` silently wins over your host session.
- **macOS** keeps Claude Code creds in the **Keychain**, not in a file, so the
  reuse-host-login path can't work there — use the subscription token instead
  (`./scripts/setup-claude-mac.sh` mints one; needs the Claude Code CLI + a
  Pro/Max plan).

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
bun test
```

Tests live in `test/` — `bun test` is scoped to that directory (see
`bunfig.toml`), so a test file placed next to the code it covers will not run.
The bundled simulator under `utils/` is a separate package with its own
dependencies and its own suite; see its README.

## Track upstream releases

In a copy of this repo, a daily job keeps one PR open from the `upstream-sync`
branch that brings `main` up to the latest upstream release. Set the variable
`INTERBOX_UPSTREAM_SYNC=off` to stop it. If the PR
includes a release with breaking changes, it opens as a draft labelled
`breaking-change`, with the upgrade notes in its description.

A release that changes CI definitions for the job's own platform, such as
`.github/workflows/` on GitHub or `azure-pipelines/` on Azure, is never pushed
by the job. On GitHub the job opens an issue instead, and on Azure the run
fails. Both give you the command to run locally once you have looked at those
changes. The jobs run the CLI version pinned in `bun.lock`, so that version only
changes when you merge a sync PR.

A copy made before these files existed needs one sync from a local checkout,
with the latest `@health-samurai/interbox` release as `<version>`:

```bash
bunx @health-samurai/interbox@<version> workspace sync
```

It pushes `upstream-sync` with your own git credentials and prints the PR link
and description. On Azure, delete that branch once its PR completes, because
the pipeline can only rebuild a branch it created.

### GitHub

[`.github/workflows/upstream-sync.yml`](.github/workflows/upstream-sync.yml) needs:

- *Allow GitHub Actions to create and approve pull requests* turned on under
  *Settings → Actions → General*. If it's greyed out, an organization owner has
  to allow it in the organization settings first.
- A ruleset on the default branch and on the branch the engine deploys from
  (`INTERBOX_WORKSPACE_GIT_REF`). It should require a pull request with at
  least one approval and *Require approval of the most recent reviewable push*,
  require the `test` and `simulator` checks, block force pushes and deletion,
  and give GitHub Actions no bypass.

Optional repository variables: `INTERBOX_UPSTREAM_SYNC=off` turns the job off,
and `INTERBOX_UPSTREAM_URL` points it at another upstream.

### Azure DevOps

[`azure-pipelines/`](azure-pipelines/) needs:

- On the repo, **Create branch** and **Contribute to pull requests** for
  `<Project> Build Service (<org>)`, and nothing more. Whoever creates a branch
  gets Contribute and Force push on it, which covers the sync branch.
- *Limit job authorization scope to current project for non-release pipelines*,
  *Protect access to repositories in YAML pipelines* and *Limit variables that
  can be set at queue time* turned on under *Project settings → Pipelines →
  Settings*.
- Both pipelines, created from a checkout of `main`:

  ```bash
  az pipelines create --name ci --yml-path azure-pipelines/ci.yml
  az pipelines create --name upstream-sync --yml-path azure-pipelines/upstream-sync.yml
  ```

- Branch policies on `main`: `ci` as build validation, at least one reviewer,
  requestors can't approve their own changes, the most recent pusher can't
  approve, and votes reset on new pushes.

The same two variables work as pipeline variables. Define them as not settable
at queue time.
