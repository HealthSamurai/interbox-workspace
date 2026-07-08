# Secure k3d reference (TLS + SSO)

A **worked, runnable reference** for deploying Interbox on Kubernetes with the
dashboard properly locked down: an internal-style **ingress**, **TLS**, and an
**SSO login gate** in front (the dashboard has no built-in auth). It runs on
[k3d](https://k3d.io) (k3s in Docker) for local evaluation — the same chart and
wiring you'd use on a real cluster (see [Production swaps](#production-swaps)).

`./deploy.sh` stands the whole thing up on [k3d](https://k3d.io) in a few minutes
so you can see it work and copy it to a real cluster.

> **Local / evaluation only.** This uses a self-signed CA, a static test login,
> and a throwaway in-cluster Postgres. Do **not** use it as-is in production —
> see [Production swaps](#production-swaps).

## What it deploys

| Component | Role |
| --------- | ---- |
| `ingress-nginx` | front door + TLS termination |
| `cert-manager` + `ca-issuer.yaml` | issues the dashboard's TLS cert from an internal CA |
| `dex.yaml` | OIDC identity provider with a test user (stand-in for Entra ID / Okta) |
| `oauth2-proxy.yaml` | the SSO gate — no session ⇒ redirect to login |
| `postgres.yaml` | throwaway Postgres |
| `values.yaml` | Interbox Helm values wiring the ingress class + TLS + SSO annotations |

`deploy.sh` generates the password hash and client/cookie secrets at run time —
nothing sensitive is committed.

## Run it

Prereqs: `k3d`, `kubectl`, `helm`, `docker`, `openssl`.

```sh
./deploy.sh
```

Then open **https://interbox.localhost:8443/** (accept the self-signed warning) and
log in as **`user@interbox.local`** / **`password`**. `*.localhost` resolves to
loopback, so no `/etc/hosts` edit is needed.

Tear down with `./teardown.sh`.

## How a request flows

```text
Browser → ingress-nginx (terminates TLS)
        → nginx asks oauth2-proxy "logged in?"  (no) → 302 to Dex login
        → user logs in → oauth2-proxy sets a cookie
        → nginx allows → Interbox dashboard
```

## Production swaps

The chart values (ingress class + `tls` + cert-manager + auth annotations) are
**identical** in production. Only these change:

| This reference (local) | Production |
| ---------------------- | ---------- |
| `ingress-nginx` on mapped host ports | `ingress-nginx` behind an **internal** LB (e.g. Azure `service.beta.kubernetes.io/azure-load-balancer-internal: true`), or AGIC |
| self-signed CA (`ca-issuer.yaml`) | cert-manager **DNS-01** (public DNS zone) or your **internal CA** / Key Vault cert |
| **Dex** + static test user (`dex.yaml`) | your real **OIDC IdP** (Entra ID / Okta): register an app, set redirect `https://<host>/oauth2/callback`, give oauth2-proxy the issuer/client id/secret |
| throwaway Postgres (`postgres.yaml`) | **managed Postgres** (private endpoint, `sslmode=require`); allowlist `pg_trgm` + `btree_gist` (Azure: `azure.extensions`) |
| host `interbox.localhost:8443` | your real private hostname on port 443 |

Everything else — the Interbox chart, the ingress annotations, cert-manager, and
oauth2-proxy — stays the same. See the docs' **Operations → Securing Dashboard
Access** for the concepts.
