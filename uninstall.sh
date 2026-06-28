#!/usr/bin/env bash
# harnery uninstaller: reverse what install.sh wired into a project, in one
# command. The mirror of install.sh.
#
#   bash harnery/uninstall.sh
#
# It always (1) runs `harn uninstall` to unwire the harness hooks and (2)
# removes the bin symlinks install.sh put on your PATH. Then, when run in a
# terminal, it asks about the two destructive extras:
#   - deleting this project's .harnery/ state (your coordination history), and
#   - deleting the harnery clone itself.
# Both default to no, and either can be pre-answered with a flag so the script
# stays scriptable (it never prompts when stdin isn't a terminal).
#
# Re-runnable: every step is idempotent. Flags:
#   --project-root <dir>   project to unwire (default: git toplevel of CWD, else
#                          harnery's parent directory)
#   --link-dir <dir>       where install.sh symlinked the bins (default: ~/.local/bin)
#   --keep-links           leave the PATH symlinks in place
#   --purge-state          delete the .harnery/ coord root (skips its prompt)
#   --remove-clone         delete the harnery clone too (skips its prompt)
#   --harness <id>         claude-code | cursor | codex (default: claude-code)
#   --dry-run              show what would change without writing (never prompts)

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
REMOVE_CLONE=0
DRY_RUN=0
HARNESS="claude-code"
while [ $# -gt 0 ]; do
  case "$1" in
    --project-root) PROJECT_ROOT="$2"; shift 2 ;;
    --link-dir)     LINK_DIR="$2"; shift 2 ;;
    --keep-links)   DO_UNLINK=0; shift ;;
    --purge-state)  PURGE_STATE=1; shift ;;
    --remove-clone) REMOVE_CLONE=1; shift ;;
    --harness)      HARNESS="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)      sed -n '2,23p' "$SOURCE"; exit 0 ;;
    *) echo "harnery uninstall: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

# Project root: explicit > git toplevel of CWD > harnery's parent directory.
if [ -z "$PROJECT_ROOT" ]; then
  PROJECT_ROOT="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -z "$PROJECT_ROOT" ] && PROJECT_ROOT="$(cd "$HARNERY_DIR/.." && pwd)"
fi
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
COORD_DIR="$PROJECT_ROOT/.harnery"

echo "harnery : $HARNERY_DIR"
echo "project : $PROJECT_ROOT"
echo

# ── Prompts for the two destructive extras ───────────────────────────────────
# Only ask on a terminal (and never during a dry run); a flag pre-answers either
# one, and a non-interactive run (pipe / CI) keeps both by default.
INTERACTIVE=0
if [ "$DRY_RUN" -eq 0 ] && [ -t 0 ]; then INTERACTIVE=1; fi

confirm() {  # $1 = question; yes only on an explicit y / yes
  local reply
  printf '%s ' "$1"
  read -r reply || return 1
  case "$reply" in [yY] | [yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

if [ "$INTERACTIVE" -eq 1 ] && [ "$PURGE_STATE" -eq 0 ] && [ -d "$COORD_DIR" ]; then
  echo "harnery saved this project's coordination history in .harnery/"
  echo "(its event log, councils, agent identities, and scratchpads):"
  echo "    $COORD_DIR"
  echo "Unwiring leaves that in place. Deleting it can't be undone."
  if confirm "Delete this project's harnery history too? [y/N]"; then PURGE_STATE=1; fi
  echo
fi

if [ "$INTERACTIVE" -eq 1 ] && [ "$REMOVE_CLONE" -eq 0 ]; then
  echo "The harnery program itself lives at:"
  echo "    $HARNERY_DIR"
  echo "Removing it deletes that whole folder, git history and all."
  echo "You'd need to re-clone it to use harnery again."
  if confirm "Delete harnery from this machine too? [y/N]"; then REMOVE_CLONE=1; fi
  echo
fi

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
remove_our_symlinks() {
  local removed=0 b link target
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
  return 0  # never let the trailing test's exit status trip the caller's set -e
}

if [ "$DO_UNLINK" -eq 1 ]; then
  remove_our_symlinks
  echo
elif [ "$REMOVE_CLONE" -eq 1 ]; then
  # --keep-links was asked for, but the clone is going away, so the links would
  # dangle; remove them anyway rather than leave dead symlinks on PATH.
  echo "(--keep-links given, but the clone is being removed, so the symlinks"
  echo " would dangle; removing them anyway)"
  remove_our_symlinks
  echo
fi

# ── 3. Closing summary, then the clone removal as the very last action ───────
if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$REMOVE_CLONE" -eq 1 ]; then echo "+ would delete the harnery clone at $HARNERY_DIR"; echo; fi
  echo "Dry run: no changes written. Re-run without --dry-run to apply."
  exit 0
fi

echo "Done. harnery is unwired from $PROJECT_ROOT."
[ "$PURGE_STATE" -eq 0 ] && echo "  (.harnery/ state kept; re-run with --purge-state to delete it)"
if [ "$REMOVE_CLONE" -eq 1 ]; then
  # Step out of the clone first so we're not deleting the working directory, then
  # remove it. This is the last statement; bash keeps the open script fd readable.
  echo "  (removing the clone at $HARNERY_DIR)"
  cd /
  rm -rf "$HARNERY_DIR"
else
  echo "  (the clone at $HARNERY_DIR is left in place; re-run with --remove-clone to delete it)"
fi
