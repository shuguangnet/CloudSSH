#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
umask 077
mode="${1:---docker}"
if [[ "$mode" == "--docker" ]]; then
  command -v docker >/dev/null || { echo 'Install Docker Engine with Compose v2 first.' >&2; exit 1; }
  docker compose version >/dev/null
  docker compose build
  docker compose run --rm --no-deps cloudssh node scripts/setup-standalone.mjs
  docker compose up -d
  echo 'CloudSSH started. Open BASE_URL (default http://localhost:8787), then use MCP in the server panel.'
elif [[ "$mode" == "--native" ]]; then
  command -v node >/dev/null || { echo 'Node.js >=22.13 is required.' >&2; exit 1; }
  node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22 || (major===22 && minor<13)) process.exit(1)' || { echo 'Node.js >=22.13 is required.' >&2; exit 1; }
  command -v pnpm >/dev/null || { echo 'Install pnpm using corepack enable first.' >&2; exit 1; }
  pnpm install --frozen-lockfile
  pnpm run build:self-hosted
  if [[ -f .env ]]; then node --env-file=.env scripts/setup-standalone.mjs;
  else node scripts/setup-standalone.mjs; fi
  echo 'Starting CloudSSH in foreground. Use systemd for persistent service; see docs/self-hosted.md.'
  if [[ -f .env ]]; then exec node --env-file=.env standalone/server.mjs; fi
  exec node standalone/server.mjs
else
  echo 'Usage: bash scripts/deploy.sh [--docker|--native]' >&2
  exit 1
fi
