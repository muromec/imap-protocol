#!/usr/bin/env bash
# ── tsc wrapper ───────────────────────────────────────────────────────────
# Runs TypeScript (v7, native) via bun.  No dependency on system node/npm.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bun "$ROOT/node_modules/.bin/tsc" "$@"
