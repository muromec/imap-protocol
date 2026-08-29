#!/usr/bin/env bash
# ── format wrapper ─────────────────────────────────────────────────────────
# Tries oxfmt first.  Falls back to prettier if oxfmt sigills (exit 132)
# or isn't installed.  Exits 0 with warning if neither works.
# Flags --write/--check pass through to both tools unchanged.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

tool_works() {
  local bin="$1"
  [ -x "$bin" ] || return 1
  "$bin" --version >/dev/null 2>&1
}

if tool_works "$ROOT/node_modules/.bin/oxfmt"; then
  exec "$ROOT/node_modules/.bin/oxfmt" "$@"
elif tool_works "$ROOT/node_modules/.bin/prettier"; then
  exec "$ROOT/node_modules/.bin/prettier" "$@"
else
  echo "fmt: no formatter available (oxfmt not working, prettier not installed)" >&2
  exit 0
fi
