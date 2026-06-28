#!/usr/bin/env bash
# harnery uninstaller: reverse what install.sh wired into a project, in one
# command. The mirror of install.sh.
#
#   bash harnery/uninstall.sh
#
# It (1) runs `harn uninstall` to unwire the harness hooks from your project, and
# (2) removes the bin symlinks install.sh placed on your PATH. By default it KEEPS
# the .harnery/ coord root (your session history) and the harnery clone itself;
# pass --purge-state to also delete .harnery/, and `rm -rf` the clone by hand when
# you want the code gone too.
#
# Re-runnable: every step is idempotent. Flags:
#   --project-root <dir>   project to unwire (default: git toplevel of CWD, else
#                          harnery's parent directory)
#   --link-dir <dir>       where install.sh symlinked the bins (default: ~/.local/bin)
#   --keep-links           leave the PATH symlinks in place
#   --purge-state          also delete the .harnery/ coord root (destructive)
#   --harness <id>         claude-code | cursor | codex (default: claude-code)
#   --dry-run              show what would change without writing

set -euo pipefail

# ── Locate this script's directory (= the harnery clone), resolving symlinks ──
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
HARNERY_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"

# ── Args ──────────────────────────────────────────────────────────────────────
PROJECT_ROOT=""
LINK_DIR="$HOME/.local/bin"
DO_UNLINK=1
PURGE_STATE=0
DRY_RUN=0
HARNESS="claude-code"
while [ $# -gt 0 ]; do
  case "$1" in
    --project-root) PROJECT_ROOT="$2"; shift 2 ;;
    --link-dir)     LINK_DIR="$2"; shift 2 ;;
    --keep-links)   DO_UNLINK=0; shift ;;
    --purge-state)  PURGE_STATE=1; shift ;;
    --harness)      HARNESS="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)      sed -n '2,20p' "$SOURCE"; exit 0 ;;
    *) echo "harnery uninstall: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

# Project root: explicit > git toplevel of CWD > harnery's parent directory.
if [ -z "$PROJECT_ROOT" ]; then
  PROJECT_ROOT="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -z "$PROJECT_ROOT" ] && PROJECT_ROOT="$(cd "$HARNERY_DIR/.." && pwd)"
fi
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"

echo "harnery : $HARNERY_DIR"
echo "project : $PROJECT_ROOT"
echo

# ── 1. Unwire the project: harness hooks (+ optional .harnery/ purge) ────────
# Delegate to `harn uninstall` so the unwiring logic lives in one place (it keeps
# any non-harnery hooks and only purges .harnery/ when asked).
UNINSTALL_ARGS=(uninstall --harness "$HARNESS" --project-root "$PROJECT_ROOT")
[ "$PURGE_STATE" -eq 1 ] && UNINSTALL_ARGS+=(--purge-state)
[ "$DRY_RUN" -eq 1 ] && UNINSTALL_ARGS+=(--dry-run)
echo "→ harn uninstall"
"$HARNERY_DIR/bin/harn" "${UNINSTALL_ARGS[@]}"
echo

# ── 2. Remove the bin symlinks (best-effort, never fatal) ────────────────────
# Only touch a symlink that points back into THIS clone, so an npm-global `harn`
# or a link from another clone is left untouched.
if [ "$DO_UNLINK" -eq 1 ]; then
  removed=0
  for b in harn agent-coord agent-hook; do
    link="$LINK_DIR/$b"
    [ -L "$link" ] || continue
    target="$(readlink "$link" 2>/dev/null || true)"
    if [ "$target" = "$HARNERY_DIR/bin/$b" ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        echo "+ would remove symlink $link"
      else
        rm -f "$link"
        echo "+ removed symlink $link"
      fi
      removed=$((removed + 1))
    else
      echo "· left $link (points elsewhere, not ours)"
    fi
  done
  [ "$removed" -eq 0 ] && echo "· no harnery symlinks found in $LINK_DIR"
  echo
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run: no changes written. Re-run without --dry-run to apply."
else
  echo "Done. harnery is unwired from $PROJECT_ROOT."
  [ "$PURGE_STATE" -eq 0 ] && echo "  (.harnery/ state kept; pass --purge-state to delete it)"
  echo "  (the clone at $HARNERY_DIR is left in place; rm -rf it to remove the code)"
fi
