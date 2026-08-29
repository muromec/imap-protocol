#!/usr/bin/env bash
# ── build wrapper ──────────────────────────────────────────────────────────
# Emits dist/ (ESM JS + .d.ts) via TypeScript.  Cleans dist/ first so stale
# files never leak into the published package.
#
# `rewriteRelativeImportExtensions` rewrites relative .ts import specifiers to
# .js in the emitted .js files.  TS7 (native) does NOT apply that rewrite to
# .d.ts output, so we post-process the declaration files — otherwise consumers
# would resolve `./foo.ts` paths that don't exist in the published package.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

rm -rf "$ROOT/dist"

bun "$ROOT/node_modules/.bin/tsc" -p "$ROOT/tsconfig.build.json"

# Rewrite `.ts` → `.js` in declaration import/export specifiers.
if [ -d "$ROOT/dist" ]; then
  find "$ROOT/dist" -name '*.d.ts' -print0 | xargs -0 sed -i -E "s/\.ts(['\"])/.js\1/g"
fi
