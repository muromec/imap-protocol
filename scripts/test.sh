#!/usr/bin/env bash
# ── test runner wrapper ────────────────────────────────────────────────────
# Runs bun test (vitest-compatible) with flags passed through.
# Parallel workers avoid vi.mock() leaks bleeding across test files.
set -euo pipefail
exec bun test --parallel=16 "$@"
