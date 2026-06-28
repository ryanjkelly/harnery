#!/usr/bin/env bash
# harnery uninstaller — remove the `harn` CLI from your machine.
#
#   curl -fsSL https://harnery.com/uninstall.sh | bash
#
# This removes the globally-installed `harnery` package (the CLI + coord engine).
# It does NOT touch any project you wired: to unwire a project (its .harnery/ +
# harness hooks), run `harn uninstall` inside that project FIRST, while `harn`
# still exists. This script prints that reminder before it removes anything.
#
# Non-interactive by design (it's meant to be piped into bash); flag/env driven.
# Idempotent; safe to re-run.
#
# Flags / env:
#   --method npm|bun     force a package manager       (env: HARNERY_INSTALL_METHOD)
#   --prefix <dir>       global prefix it was installed under  (env: HARNERY_INSTALL_DIR)
#   --dry-run            print what would run, change nothing
#   --help               show this help

set -eu

PKG="harnery"

show_help() {
  cat <<'EOF'
harnery uninstaller — remove the `harn` CLI.

  curl -fsSL https://harnery.com/uninstall.sh | bash

Unwire a PROJECT first (while `harn` still exists):  harn init's inverse →  harn uninstall

Flags (pass through the pipe with `bash -s -- <flags>`):
  --method npm|bun     force a package manager        (env HARNERY_INSTALL_METHOD)
  --prefix <dir>       global prefix it was installed under  (env HARNERY_INSTALL_DIR)
  --dry-run            print what would run, change nothing
  --help               show this help
EOF
}

have() { command -v "$1" >/dev/null 2>&1; }

main() {
  local method="${HARNERY_INSTALL_METHOD:-}"
  local prefix="${HARNERY_INSTALL_DIR:-}"
  local dry_run=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --method) method="$2"; shift 2 ;;
      --prefix) prefix="$2"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      -h | --help) show_help; exit 0 ;;
      *) echo "harnery uninstall: unknown argument '$1' (try --help)" >&2; exit 1 ;;
    esac
  done

  # Same package-manager precedence as the installer: explicit, else npm, else bun.
  if [ -z "$method" ]; then
    if have npm; then
      method=npm
    elif have bun; then
      method=bun
    fi
  fi

  if [ -z "$method" ]; then
    echo "harnery uninstall: no npm or bun found, so there's nothing for this script" >&2
    echo "to remove (harnery may have been installed another way)." >&2
    exit 0
  fi

  echo "Reminder: this removes the harnery CLI, not any project you wired."
  echo "If you haven't already, run \`harn uninstall\` inside each project first."
  echo
  echo "harnery uninstaller"
  echo "  package : $PKG"
  echo "  method  : $method"
  [ -n "$prefix" ] && echo "  prefix  : $prefix"
  echo

  case "$method" in
    npm)
      if [ -n "$prefix" ]; then
        run "$dry_run" npm rm -g --prefix "$prefix" "$PKG"
      else
        run "$dry_run" npm rm -g "$PKG"
      fi
      ;;
    bun)
      if [ -n "$prefix" ]; then
        run "$dry_run" env "BUN_INSTALL=$prefix" bun remove -g "$PKG"
      else
        run "$dry_run" bun remove -g "$PKG"
      fi
      ;;
    *)
      echo "harnery uninstall: unknown method '$method' (expected npm|bun)" >&2
      exit 1
      ;;
  esac

  echo
  if [ "$dry_run" -eq 1 ]; then
    echo "Dry run: nothing removed."
  else
    echo "Done. harnery is removed. (Any .harnery/ directories in your projects are left as-is.)"
  fi
}

# echo a command, then run it unless this is a dry run ($1 = dry_run flag).
run() {
  local dry="$1"; shift
  echo "+ $*"
  [ "$dry" -eq 1 ] && return 0
  "$@"
}

# Call main last so a truncated download (curl | bash) can't run a partial script.
main "$@"
