#!/bin/bash
# Integration tests: exercise the `harn` binary end-to-end against a
# fresh tmp coord root. Each test sets HARNERY_COORD_ROOT_OVERRIDE +
# HARN_COORD_ROOT to isolate from the host's .harnery/.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNERY_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HARN="$HARNERY_DIR/bin/harn"

# Set up an isolated coord root so we don't trip over the host's state.
TMPDIR_TEST=$(mktemp -d -t harn-it-XXXXXX)
export HARNERY_COORD_ROOT_OVERRIDE="$TMPDIR_TEST"
export HARN_COORD_ROOT="$TMPDIR_TEST"
mkdir -p "$TMPDIR_TEST/.harnery/active"
git -C "$TMPDIR_TEST" init -q

cleanup() {
  rm -rf "$TMPDIR_TEST"
}
trap cleanup EXIT

pass=0
fail=0

check() {
  local name="$1"
  local cmd="$2"
  local needle="$3"
  local allow_nonzero="${4:-0}"
  output=$(eval "$cmd" 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ] && [ "$allow_nonzero" -ne 1 ]; then
    echo "  ✗ $name: exited non-zero (rc=$rc)"
    echo "    got: $(printf '%s' "$output" | head -3)"
    fail=$((fail + 1))
    return
  fi
  if printf '%s' "$output" | grep -q -- "$needle"; then
    echo "  ✓ $name"
    pass=$((pass + 1))
  else
    echo "  ✗ $name: output didn't include '$needle'"
    echo "    got: $(printf '%s' "$output" | head -3)"
    fail=$((fail + 1))
  fi
}

echo "harnery integration tests"
echo "========================="
echo ""

# 1. harn --help
check "harn --help mentions tokens" "$HARN --help" "tokens"
check "harn --help mentions doctor" "$HARN --help" "doctor"
check "harn --help mentions backup" "$HARN --help" "backup"
check "harn --help mentions web" "$HARN --help" "web"
check "harn --help mentions agents" "$HARN --help" "agents"
check "harn --help mentions adapter" "$HARN --help" "adapter"
check "harn --help mentions run" "$HARN --help" "run"
check "harn --help mentions approval" "$HARN --help" "approval"
check "harn --help mentions artifacts" "$HARN --help" "artifacts"

# 2. harn doctor
check "harn doctor reports node check" "$HARN doctor" "node"
check "harn doctor reports git check" "$HARN doctor" "git"
check "harn doctor --json emits a checks array" \
  "$HARN doctor --json | head -c 400" '"checks"'

# 3. harn tokens (basic functional)
TOKENS_TMP=$(mktemp -t harn-it-tokens.XXXXXX.txt)
printf "hello world\n" > "$TOKENS_TMP"
check "harn tokens counts a small file" "$HARN tokens '$TOKENS_TMP'" "tokens"
rm -f "$TOKENS_TMP"

# 4. harn artifacts manages a preview-before-delete lifecycle. Rolling
# retention anchors expiry to the newest tree change (mtime AND ctime, and
# ctime cannot be backdated), so a smoke run on a real clock can never
# observe managed-expired; that path is covered by the unit tests with an
# injected clock (src/core/artifacts/index.test.ts). Assert the live
# classifications and the nothing-expired delete accounting instead.
check "harn artifacts creates a managed workspace" \
  "$HARN artifacts create integration-artifact --purpose 'integration smoke' --days 1" \
  '"artifact_id"'
check "harn artifacts classifies a fresh workspace as current" \
  "$HARN artifacts clean" '"managed-current"'
check "harn artifacts cleanup deletes nothing without expiry" \
  "$HARN artifacts clean --yes" '"deleted":0'

# 5. harn adapter catalog + offline bench
check "harn adapter list includes all built-ins" \
  "$HARN adapter list" "cursor-agent"
# Drift is a legitimate result and exits non-zero, so these assert on output.
# A host whose installed vendor CLI differs from the recorded contract will
# report contract drift; that must not fail the smoke test.
check "harn adapter bench makes no model calls" \
  "$HARN adapter bench" "offline (no model calls)" 1
check "harn adapter bench reports the basis of each result" \
  "$HARN adapter bench" "basis:" 1

# 6. harn run --help exposes proof and workspace operations; approval is top-level
check "harn --help mentions approval" "$HARN --help" "approval"
check "harn run --help mentions proof" "$HARN run --help" "proof"
check "harn run --help mentions resume" "$HARN run --help" "resume"
check "harn run --help mentions integration" "$HARN run --help" "integration"
check "harn run --help mentions cleanup" "$HARN run --help" "cleanup"
check "harn run proof --help mentions JSON output" \
  "$HARN run proof --help" "--json"
check "harn run integration --help exposes phased apply" \
  "$HARN run integration --help" "apply"
check "harn run cleanup --help requires confirmation" \
  "$HARN run cleanup --help" "--yes"
check "harn approval --help exposes resolution" \
  "$HARN approval --help" "approve"
check "harn approval list starts with an empty inbox" \
  "$HARN approval list" "no workflow approvals"

# 7. harn web --help mentions all subcommands
check "harn web --help mentions up" "$HARN web --help" "up"
check "harn web --help mentions build" "$HARN web --help" "build"
check "harn web --help mentions start" "$HARN web --help" "start"

# 8. harn backup --help mentions subcommands
check "harn backup --help mentions snapshot" "$HARN backup --help" "snapshot"
check "harn backup --help mentions restore" "$HARN backup --help" "restore"

# 9. Error path: harn backup init without restic surfaces a structured error
if ! command -v restic >/dev/null 2>&1; then
  check "harn backup init without restic emits restic_missing" \
    "$HARN backup init 2>&1" "restic_missing" 1
fi

echo ""
total=$((pass + fail))
if [ "$fail" -eq 0 ]; then
  echo "✓ Integration tests passed ($pass/$total)"
  exit 0
else
  echo "✗ Integration tests failed ($pass/$total passed, $fail failed)"
  exit 1
fi
