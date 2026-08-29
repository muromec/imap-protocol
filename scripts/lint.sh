#!/usr/bin/env bash
# ── lint wrapper ───────────────────────────────────────────────────────────
# Tries oxlint first.  Falls back to eslint if oxlint sigills (exit 132)
# or isn't installed.  Exits 0 with warning if neither works.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

tool_works() {
  local bin="$1"
  [ -x "$bin" ] || return 1
  # Smoke test — returns 132 if binary sigills.
  "$bin" --version >/dev/null 2>&1
}

if tool_works "$ROOT/node_modules/.bin/oxlint"; then
  exec "$ROOT/node_modules/.bin/oxlint" "$@"
elif tool_works "$ROOT/node_modules/.bin/eslint"; then
  exec "$ROOT/node_modules/.bin/eslint" "$@"
else
  echo "lint: no linter available (oxlint not working, eslint not installed)" >&2
  exit 0
fi
