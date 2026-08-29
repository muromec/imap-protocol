#!/usr/bin/env bash
# ── Pre-commit validation ─────────────────────────────────────────────────
# Usage:  bash scripts/validate.sh
# Hook:   cp scripts/pre-commit .git/hooks/pre-commit
#
# Checks: typecheck (tsc v7), no-unsafe-cast lint (diff only), oxlint
# (or fallback), format:check, build (dist emit), tests + coverage.
# Runtime-agnostic: wrappers handle riscv64 fallbacks transparently.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'
COVERAGE_THRESHOLD=65

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
failures=0

safe_grep() { grep "$@" 2>/dev/null || true; }

# ── riscv64 timeout advisory ─────────────────────────────────────────────
ARCH=$(uname -m)
if [ "$ARCH" = "riscv64" ]; then
  echo -e "  ${YELLOW}[riscv64 detected — typecheck may take ~10s, full suite ~20s. If hooks time out, increase the timeout rather than bypassing.]${NC}"
  echo -e "  ${YELLOW}[All commits bypassing this gate will be reverted.]${NC}"
fi

# ── timing helper ────────────────────────────────────────────────────────
step_start=0
step_start_ms() { step_start=$(date +%s%3N 2>/dev/null || echo 0); }
step_elapsed() {
  local now=$(date +%s%3N 2>/dev/null || echo 0)
  local elapsed=$((now - step_start))
  if [ $elapsed -ge 1000 ]; then
    printf "%d.%01ds" $((elapsed / 1000)) $(((elapsed % 1000) / 100))
  else
    printf "%dms" $elapsed
  fi
}

run() {
  local label="$1"; shift
  echo -n "  $label … "
  step_start_ms
  if out=$("$@" 2>&1); then
    echo -e "${GREEN}ok${NC} ($(step_elapsed))"
    return 0
  else
    rc=$?
    echo -e "${RED}FAIL${NC} ($(step_elapsed))"
    echo "$out" | tail -20
    failures=$((failures + 1))
    return $rc
  fi
}

# ── typecheck ────────────────────────────────────────────────────
echo -n "  typecheck … "
step_start_ms
tsc_timeout=300
if [ "$ARCH" = "riscv64" ]; then
  tsc_timeout=600
fi
if timeout $tsc_timeout bash "$ROOT/scripts/tsc.sh" --noEmit 2>&1; then
  echo -e "${GREEN}ok${NC} ($(step_elapsed))"
else
  rc=$?
  if [ $rc -eq 124 ]; then
    echo -e "${RED}FAIL (timed out after ${tsc_timeout}s)${NC} ($(step_elapsed))"
  else
    echo -e "${RED}FAIL${NC} ($(step_elapsed))"
  fi
  failures=$((failures + 1))
fi

# ── lint: no new unsafe casts ('as any' / 'as unknown as') ───────────────
echo -n "  lint (no as any / as unknown as) … "
step_start_ms
new_unsafe=$(git diff --cached -U0 -- '*.ts' 2>/dev/null | safe_grep '^+' | safe_grep -v '^+++' | safe_grep -E 'as any|as unknown as' || true)
if [ -z "$new_unsafe" ]; then
  echo -e "${GREEN}ok${NC} ($(step_elapsed))"
else
  echo -e "${RED}FAIL (new as any / as unknown as in diff)${NC} ($(step_elapsed))"
  echo "$new_unsafe"
  failures=$((failures + 1))
fi

# ── oxlint (blocking) ─────────────────────────────────────────────────────
run "lint (oxlint)" bash "$ROOT/scripts/lint.sh" -D correctness -D suspicious src/*.ts test/*.ts scripts/*.ts

# ── format:check (blocking) ──────────────────────────────────────────────
run "format:check" bash "$ROOT/scripts/fmt.sh" --check src/*.ts test/*.ts scripts/*.ts

# ── build (dist emit) ─────────────────────────────────────────────────────
run "build" bash "$ROOT/scripts/build.sh"

# ── tests + coverage threshold ───────────────────────────────────────────
echo -n "  test + coverage (>=${COVERAGE_THRESHOLD}%) … "
step_start_ms
test_output=$(bash "$ROOT/scripts/test.sh" --coverage --coverage-reporter=text --parallel=16 2>&1)
test_rc=$?

if [ $test_rc -ne 0 ]; then
  echo -e "${RED}FAIL (tests failed)${NC} ($(step_elapsed))"
  echo "$test_output" | tail -20
  failures=$((failures + 1))
else
  cov_pct=$(echo "$test_output" | safe_grep "All files" | head -1 | awk '{print $(NF-1)}' | tr -d ' ')
  cov_int=${cov_pct%.*}

  if [ -n "$cov_int" ] && [ "$cov_int" -ge "$COVERAGE_THRESHOLD" ]; then
    echo -e "${GREEN}ok (${cov_pct}%)${NC} ($(step_elapsed))"
  else
    echo -e "${RED}FAIL: coverage ${cov_pct:-?}% < ${COVERAGE_THRESHOLD}%${NC} ($(step_elapsed))"
    failures=$((failures + 1))
  fi
fi

# ── result ────────────────────────────────────────────────────────────────
echo ""
if [ $failures -eq 0 ]; then
  echo -e "${GREEN}All checks passed.${NC}"
  exit 0
else
  echo -e "${RED}${failures} check(s) failed.${NC}"
  echo -e "  ${YELLOW}--no-verify requires special permission from the repository owner."
  echo -e "  Commits that use --no-verify without permission WILL BE REVERTED."
  echo -e "  Instead: wait patiently, increase the timeout, or fix the underlying issue.${NC}"
  exit 1
fi
