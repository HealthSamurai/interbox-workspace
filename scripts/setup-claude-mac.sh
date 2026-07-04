#!/usr/bin/env bash
# Provision the dashboard assistant's Claude auth for local dev on macOS.
#
# The assistant is a Claude Code agent running inside the interbox container,
# which has no ~/.claude of its own. On Linux/Windows you can bind-mount the
# host login (docker-compose option 3), but macOS keeps Claude Code creds in
# the Keychain, not in a file — so that mount is empty there. Instead we mint a
# subscription OAuth token on the host and hand it to the container via .env.
#
# Requires: Claude Code CLI + a Pro/Max plan. Pay-per-token users don't need
# this — set ANTHROPIC_API_KEY in .env instead.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v claude >/dev/null || {
  echo "error: Claude Code CLI not found." >&2
  echo "       install: npm i -g @anthropic-ai/claude-code" >&2
  exit 1
}

[ -f .env ] || { cp .env.example .env; echo "created .env from .env.example"; }

echo "Opening the browser for Claude OAuth (needs a Pro/Max plan)…"
# setup-token prints guidance plus the token; pull the sk-ant-oat… line out,
# falling back to the last non-empty line if the prefix ever changes.
out="$(claude setup-token)"
token="$(printf '%s\n' "$out" | grep -oE 'sk-ant-oat[[:alnum:]_-]+' | head -n1 || true)"
[ -n "$token" ] || token="$(printf '%s\n' "$out" | awk 'NF' | tail -n1 | tr -d '[:space:]')"
[ -n "$token" ] || { echo "error: no token returned by 'claude setup-token'." >&2; exit 1; }

# Replace an existing assignment in place, else append. BSD sed (macOS) form.
if grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' .env; then
  sed -i '' "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${token}|" .env
else
  printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$token" >> .env
fi

echo "wrote CLAUDE_CODE_OAUTH_TOKEN to .env"
echo "next: docker compose up  →  the dashboard assistant can now answer"
