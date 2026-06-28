#!/usr/bin/env bash
# harnery dev/clone setup: turn a fresh `git clone` into a project that's
# harnery-ready, in one command. This is for contributing to harnery or running
# the web dashboard (neither ships on npm).
#
#   ./scripts/setup.sh            # run from the repo root
#
# Just want the CLI? You don't need a clone:
#   curl -fsSL https://harnery.com/install.sh | bash
#
# This script (1) installs harnery's deps, (2) builds the Node dist/ when Bun
# isn't present, (3) runs `harn init` to create .harnery/ + wire the harness
# hooks in your project, and (4) links the bins onto PATH (best-effort).
#
# To reverse everything this did, run the mirror:  ./scripts/teardown.sh
#
# Re-runnable: every step is idempotent. Flags:
#   --project-root <dir>   project to wire (default: git toplevel of CWD, else
#                          harnery's parent directory)
#   --link-dir <dir>       where to symlink the bins (default: ~/.local/bin)
#   --no-link              skip the PATH symlinks entirely
#   --harness <id>         claude-code | cursor | codex (default: claude-code)

set -euo pipefail

# ── Locate this script's directory (= the harnery clone), resolving symlinks ──
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
# This script lives in scripts/, so the harnery clone root is one level up.
HARNERY_DIR="$(cd "$(dirname "$SOURCE")/.." && pwd)"

# ── Args ──────────────────────────────────────────────────────────────────────
PROJECT_ROOT=""
LINK_DIR="$HOME/.local/bin"
DO_LINK=1
HARNESS="claude-code"
while [ $# -gt 0 ]; do
  case "$1" in
    --project-root) PROJECT_ROOT="$2"; shift 2 ;;
    --link-dir)     LINK_DIR="$2"; shift 2 ;;
    --no-link)      DO_LINK=0; shift ;;
    --harness)      HARNESS="$2"; shift 2 ;;
    -h|--help)      sed -n '2,22p' "$SOURCE"; exit 0 ;;
    *) echo "harnery setup: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

# Project root: explicit > git toplevel of CWD > harnery's parent directory.
if [ -z "$PROJECT_ROOT" ]; then
  PROJECT_ROOT="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -z "$PROJECT_ROOT" ] && PROJECT_ROOT="$(cd "$HARNERY_DIR/.." && pwd)"
fi
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"

have() { command -v "$1" >/dev/null 2>&1; }

echo "harnery : $HARNERY_DIR"
echo "project : $PROJECT_ROOT"
echo

# ── 1 + 2. Install deps; build dist/ on a Bun-free host ──────────────────────
cd "$HARNERY_DIR"
if have bun; then
  echo "→ bun install (Bun runs the TS source directly, no build step)"
  bun install
else
  if ! have npm; then
    echo "harnery setup: need either Bun (https://bun.sh) or Node+npm (>=20)." >&2
    exit 1
  fi
  echo "→ npm install"
  npm install
  echo "→ npm run build (Node runs the compiled dist/)"
  npm run build
fi
echo

# ── 3. Wire the project: .harnery/ coord root + harness hooks ────────────────
echo "→ harn init"
"$HARNERY_DIR/bin/harn" init --harness "$HARNESS" --project-root "$PROJECT_ROOT"
echo

# ── 4. Put the bins on PATH (best-effort, never fatal) ───────────────────────
if [ "$DO_LINK" -eq 1 ]; then
  mkdir -p "$LINK_DIR"
  for b in harn agent-coord agent-hook; do
    ln -sf "$HARNERY_DIR/bin/$b" "$LINK_DIR/$b"
  done
  echo "→ linked harn, agent-coord, agent-hook into $LINK_DIR"
  case ":$PATH:" in
    *":$LINK_DIR:"*) echo "  ✓ $LINK_DIR is already on PATH" ;;
    *) echo "  ! add it to PATH:  export PATH=\"$LINK_DIR:\$PATH\"  (then restart your shell)" ;;
  esac
  echo
fi

echo "Done. Verify with:  harn doctor"
echo "To undo:   bash $HARNERY_DIR/scripts/teardown.sh"
