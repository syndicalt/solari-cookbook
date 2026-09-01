#!/usr/bin/env bash
# demo-live.sh — full three-surface vendor close against live Solari.
#
# The conductor deploys the portal into the run's own sandbox and serves it
# via previewUrl (NOAPI_PORTAL=sandbox): a cloud browser cannot reach this
# machine's localhost, and accounts limited to one concurrent VM cannot run
# a second sandbox just for the portal. Requires SOLARI_API_KEY (env or .env).
# Measured on Starter: ~$0.002 per green run, ~33-45s wall.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${SOLARI_API_KEY:-}" && ! -f .env ]]; then
  echo "demo: SOLARI_API_KEY not set and no .env — nothing to do (try make demo-offline)"
  exit 2
fi

NOAPI_PORTAL=sandbox node src/cli.ts run scenarios/vendor-close.json
