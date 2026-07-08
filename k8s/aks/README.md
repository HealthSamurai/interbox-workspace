# Secure AKS reference (TLS + SSO)

Production-shaped templates for deploying Interbox on **AKS** with the dashboard
behind an **internal ingress-nginx**, **cert-manager** TLS, and **Entra ID** SSO.

> **These are templates, not a verified one-command deploy.** They depend on your
> Azure resources (DNS zone, Entra tenant, managed Postgres, workload identity), so
> they can't be exercised end-to-end here. Fill every `<placeholder>` and validate
> in a staging cluster. The **[k3d reference](../k3d/)** is the runnable, verified
> version of the same architecture — start there to see it work.

Same architecture as k3d; the swaps are: internal LB, cert-manager real issuer,
Entra ID (not Dex), managed Postgres.

## Prerequisites

- An **AKS** cluster with **workload identity** enabled.
- **ingress-nginx** installed *internal* — `helm install ingress-nginx
  ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace -f
  ingress-nginx.values.yaml` (gives its LB a private IP).
- **cert-manager** installed (`--set crds.enabled=true`).
- **Azure Database for PostgreSQL Flexible Server** reachable privately. Allowlist
  the extensions Interbox needs — set the server parameter
  **`azure.extensions = PG_TRGM,BTREE_GIST`** — *before* first boot, or the schema
  migration fails.
- An **Entra ID app registration** for the dashboard (below).
- Interbox needs **outbound** access to your workspace repo and Aidbox; for the
  **FHIR-poll** path, pin the cluster's **NAT-gateway egress IP** so upstreams
  (e.g. Epic) can allowlist it.

## 1. TLS issuer — pick one

- **Public DNS zone (recommended)** → `kubectl apply -f clusterissuer-dns01.yaml`.
  cert-manager gets auto-renewing, publicly-trusted certs via Azure DNS DNS-01 —
  works even when the host's A record is a private IP. Federate the cert-manager
  service account with a managed identity that has *DNS Zone Contributor*.
- **Private-DNS-only host** → `kubectl apply -f clusterissuer-internal-ca.yaml` and
  set `ingress.annotations.cert-manager.io/cluster-issuer: internal-ca` in
  `values.yaml`. Distribute the CA to clients.

## 2. Entra ID app + secret

1. Entra ID → App registrations → New. Add a **Web** redirect URI:
   `https://<host>/oauth2/callback`.
2. Certificates & secrets → new **client secret**.
3. Create the secret oauth2-proxy reads:

   ```sh
   kubectl create secret generic oauth2-proxy-secret \
     --from-literal=client-id=<entra-app-client-id> \
     --from-literal=client-secret=<entra-client-secret> \
     --from-literal=cookie-secret=$(openssl rand -hex 16)
   ```

## 3. Deploy the gate + Interbox

```sh
# fill <tenant-id> and <host> in oauth2-proxy.yaml first
kubectl apply -f oauth2-proxy.yaml

helm repo add healthsamurai https://healthsamurai.github.io/helm-charts
helm upgrade --install interbox healthsamurai/interbox -f values.yaml   # fill placeholders first
```

## 4. Verify

```sh
# unauthenticated -> 302 to the Entra login
curl -sk -o /dev/null -D - https://<host>/api/messages | grep -iE '^HTTP|^location'
# cert issued + trusted (DNS-01) or CA-signed (internal CA)
echo | openssl s_client -connect <host>:443 -servername <host> 2>/dev/null | openssl x509 -noout -issuer
```

Then browse `https://<host>/`, authenticate with Entra ID, land on the dashboard.

## Files

| File | Purpose |
| ---- | ------- |
| `values.yaml` | Interbox chart values: internal ingress + TLS + SSO annotations + internal MLLP LB |
| `ingress-nginx.values.yaml` | install ingress-nginx as an *internal* controller |
| `clusterissuer-dns01.yaml` | **primary** TLS issuer (Azure DNS DNS-01) |
| `clusterissuer-internal-ca.yaml` | alternative TLS issuer (private-DNS-only) |
| `oauth2-proxy.yaml` | SSO gate wired to Entra ID |

Concepts: the docs' **Operations → Securing Dashboard Access**.
