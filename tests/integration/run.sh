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
check "harn --help mentions sync" "$HARN --help" "sync"
check "harn --help mentions web" "$HARN --help" "web"
check "harn --help mentions agents" "$HARN --help" "agents"
check "harn --help mentions adapter" "$HARN --help" "adapter"
check "harn --help mentions durable work" "$HARN --help" "work"
check "harn --help mentions governor" "$HARN --help" "governor"
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

# 7. harn work exposes the complete daemonless lifecycle
check "harn work --help mentions reconcile" "$HARN work --help" "reconcile"
check "harn work --help mentions explicit retry" "$HARN work --help" "retry"
check "harn work list starts empty" "$HARN work list" "no durable work"
WORK_CONTEXT_FIXTURE="$TMPDIR_TEST/work-context.mjs"
printf '%s\n' 'export default async ({ work }) => work;' > "$WORK_CONTEXT_FIXTURE"
check "harn work creates a reusable context-backed assignment" \
  "$HARN work create 'Integration context' '$WORK_CONTEXT_FIXTURE' --id integration-context --objective 'Execute reusable context' --accept 'The exact assignment reaches the script'" \
  "integration-context"
check "harn work injects the exact assignment into generic workflow code" \
  "$HARN work run integration-context --json" "Execute reusable context"
WORK_CONTEXT_RUN_ID=$(
  "$HARN" work show integration-context --json |
    node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => console.log(JSON.parse(s).projection.latest_run_id))'
)
check "harn run proof preserves the work context" \
  "$HARN run proof '$WORK_CONTEXT_RUN_ID' --json" \
  '"work_context"'
check "harn run proof preserves the attempt context" \
  "$HARN run proof '$WORK_CONTEXT_RUN_ID' --json" \
  '"attempt_context"'

# 8. harn governor exposes bounded goal execution
check "harn governor --help mentions tick" "$HARN governor --help" "tick"
check "harn governor --help mentions run" "$HARN governor --help" "run"
check "harn governor exposes replanning review" "$HARN governor plan --help" "approve"
check "harn governor exposes attention recovery" "$HARN governor plan --help" "retry"
check "harn governor list starts empty" "$HARN governor list" "no durable governors"
check "harn governor service exposes lifecycle commands" \
  "$HARN governor service --help" "status"
check "harn governor service starts unconfigured" \
  "$HARN governor service status" "unconfigured"

MISSION_FIXTURE="$TMPDIR_TEST/mission-fixture"
mkdir -p "$MISSION_FIXTURE"
printf '%s\n' '{"planner":{"instructions":"Plan bounded milestones","adapter":"codex"},"reviewer":{"instructions":"Review milestone plans independently","adapter":"codex"}}' \
  > "$MISSION_FIXTURE/team.json"
printf '%s\n' '{"objective":"Deliver a verified mission","acceptance":["The mission proof passes"],"max_milestones":2}' \
  > "$MISSION_FIXTURE/mission.json"
printf '%s\n' 'export default async () => "done";' \
  > "$MISSION_FIXTURE/workflow.mjs"
printf '%s\n' '{"planner_specialist":"planner","max_replans":3,"review":{"reviewer_specialists":["reviewer"],"max_revision_rounds":1},"templates":{"delivery":{"workflow":"./workflow.mjs","root":true}}}' \
  > "$MISSION_FIXTURE/replanning.json"
check "harn governor creates an objective-first mission" \
  "$HARN governor create --id goal-integration-mission --team '$MISSION_FIXTURE/team.json' --mission '$MISSION_FIXTURE/mission.json' --replanning '$MISSION_FIXTURE/replanning.json'" \
  "next: plan_initial"
check "harn governor renders frozen plan review policy" \
  "$HARN governor show goal-integration-mission" "plan review: reviewers=reviewer, max_revision_rounds=1"
check "harn governor shows frozen mission progress" \
  "$HARN governor show goal-integration-mission" "milestones: 0/2"
check "harn governor json freezes reviewed planning policy" \
  "$HARN governor show goal-integration-mission --json" '"max_revision_rounds":1'

# 9. harn web --help mentions all subcommands
check "harn web --help mentions up" "$HARN web --help" "up"
check "harn web --help mentions build" "$HARN web --help" "build"
check "harn web --help mentions start" "$HARN web --help" "start"

# 10. harn backup --help mentions subcommands
check "harn backup --help mentions snapshot" "$HARN backup --help" "snapshot"
check "harn backup --help mentions restore" "$HARN backup --help" "restore"

# 11. harn sync --help mentions subcommands
check "harn sync --help mentions push" "$HARN sync --help" "push"
check "harn sync --help mentions pull" "$HARN sync --help" "pull"

# 12. Error path: harn backup init without restic surfaces a structured error
if ! command -v restic >/dev/null 2>&1; then
  check "harn backup init without restic emits restic_missing" \
    "$HARN backup init 2>&1" "restic_missing" 1
fi

if ! command -v rclone >/dev/null 2>&1; then
  check "harn sync init without rclone emits rclone_missing" \
    "$HARN sync init 2>&1" "rclone_missing" 1
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
