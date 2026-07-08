#!/usr/bin/env bash
# One-command SECURE reference deploy on k3d:
#   nginx ingress + cert-manager (internal CA) TLS + oauth2-proxy SSO + Dex IdP
#   + Interbox (Helm) + throwaway Postgres.
#
# LOCAL / EVALUATION ONLY: self-signed CA, a test login, and a throwaway Postgres.
# See README.md for the production swaps. Re-runnable (recreates the cluster).
set -euo pipefail
cd "$(dirname "$0")"
CLUSTER=interbox
HTTPS=8443

echo "==> (re)create k3d cluster '$CLUSTER' (ingress-nginx, no traefik)"
k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
k3d cluster create "$CLUSTER" \
  --k3s-arg "--disable=traefik@server:0" \
  -p "8081:80@loadbalancer" -p "${HTTPS}:443@loadbalancer" --wait

echo "==> helm repos"
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
helm repo add healthsamurai https://healthsamurai.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null

echo "==> ingress-nginx"
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  -n ingress-nginx --create-namespace \
  --set controller.service.type=LoadBalancer --wait

echo "==> cert-manager + internal CA"
helm upgrade --install cert-manager jetstack/cert-manager \
  -n cert-manager --create-namespace --set crds.enabled=true --wait
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=120s
kubectl apply -f ca-issuer.yaml
kubectl -n cert-manager wait --for=condition=Ready certificate/local-ca --timeout=90s

echo "==> postgres"
kubectl apply -f postgres.yaml
kubectl rollout status deploy/interbox-pg --timeout=120s

echo "==> generate local secrets (bcrypt password hash + client/cookie secrets)"
BHASH=$(docker run --rm httpd:2-alpine htpasswd -bnBC 10 "" 'password' | tr -d ':\n' | sed 's/\$2y/\$2a/')
CLIENT_SECRET=$(openssl rand -hex 24)
COOKIE=$(openssl rand -hex 16)

echo "==> Dex (OIDC identity provider) + test user"
kubectl create namespace dex --dry-run=client -o yaml | kubectl apply -f -
cat > /tmp/dex-config.yaml <<EOF
issuer: https://dex.localhost:${HTTPS}/dex
storage: { type: memory }
web: { http: 0.0.0.0:5556 }
oauth2: { skipApprovalScreen: true }
staticClients:
  - id: interbox-dashboard
    name: Interbox
    secret: ${CLIENT_SECRET}
    redirectURIs: [ "https://interbox.localhost:${HTTPS}/oauth2/callback" ]
enablePasswordDB: true
staticPasswords:
  - email: "user@interbox.local"
    hash: "${BHASH}"
    username: "user"
    userID: "1"
EOF
kubectl -n dex create configmap dex-config --from-file=config.yaml=/tmp/dex-config.yaml \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f dex.yaml
kubectl -n dex rollout status deploy/dex --timeout=120s

echo "==> oauth2-proxy (SSO gate)"
kubectl create secret generic oauth2-proxy-secret \
  --from-literal=client-secret="${CLIENT_SECRET}" \
  --from-literal=cookie-secret="${COOKIE}" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f oauth2-proxy.yaml
kubectl rollout status deploy/oauth2-proxy --timeout=120s

echo "==> interbox (Helm) — boots by cloning + building the workspace, give it a minute"
helm upgrade --install interbox healthsamurai/interbox -f values.yaml
for i in $(seq 1 40); do
  [ "$(kubectl get pods -l app=interbox -o jsonpath='{.items[0].status.containerStatuses[0].ready}' 2>/dev/null)" = "true" ] && break
  sleep 6
done

echo
echo "==> verify"
sleep 3
echo "-- SSO gate (no session -> should 302 to the login):"
curl -sk -o /dev/null -D - "https://interbox.localhost:${HTTPS}/api/messages" | grep -iE '^HTTP|^location' || true
echo "-- TLS issuer (should be the internal CA):"
echo | openssl s_client -connect "interbox.localhost:${HTTPS}" -servername interbox.localhost 2>/dev/null | openssl x509 -noout -issuer || true
echo
echo "Done.  Open:  https://interbox.localhost:${HTTPS}/"
echo "       Login: user@interbox.local  /  password   (accept the self-signed cert warning)"
echo "       Down:  ./teardown.sh"
