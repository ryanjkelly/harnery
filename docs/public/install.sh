#!/usr/bin/env bash
# harnery installer — the one-liner that puts the `harn` CLI on your PATH.
#
#   curl -fsSL https://harnery.com/install.sh | bash
#
# It installs the published `harnery` npm package globally with a package manager
# you already have (npm preferred for a predictable global bin, Bun otherwise),
# checks that bin dir is on your PATH, and verifies the result. It does NOT wire a
# project — run `harn init` in your repo for that (it prints the reminder).
#
# Non-interactive by design: piped into bash there is no terminal to prompt at,
# so every choice is flag- or env-driven. Idempotent; safe to re-run.
#
# Pass flags through the pipe with `bash -s --`:
#   curl -fsSL https://harnery.com/install.sh | bash -s -- --method bun --version 0.3.2
#
# Flags / env:
#   --method npm|bun        force a package manager           (env: HARNERY_INSTALL_METHOD)
#   --version <v>           install a specific version        (env: HARNERY_VERSION)
#   --prefix <dir>          global install prefix             (env: HARNERY_INSTALL_DIR)
#   --install-runtime       install Bun first if no Bun/Node is found
#   --dry-run               print what would run, change nothing
#   --help                  show this help
#   HARNERY_INSTALL_SOURCE  npm spec or local .tgz to install instead of harnery@<version>
#                           (lets CI install a freshly-packed tarball)

set -eu

PKG="harnery"

show_help() {
  cat <<'EOF'
harnery installer — put the `harn` CLI on your PATH.

  curl -fsSL https://harnery.com/install.sh | bash

Flags (pass through the pipe with `bash -s -- <flags>`):
  --method npm|bun     force a package manager        (env HARNERY_INSTALL_METHOD)
  --version <v>        install a specific version     (env HARNERY_VERSION)
  --prefix <dir>       global install prefix          (env HARNERY_INSTALL_DIR)
  --install-runtime    install Bun first if neither Bun nor Node is found
  --dry-run            print what would run, change nothing
  --help               show this help

After installing, wire a project with:  harn init
Remove the CLI with:  curl -fsSL https://harnery.com/uninstall.sh | bash
EOF
}

have() { command -v "$1" >/dev/null 2>&1; }

main() {
  local method="${HARNERY_INSTALL_METHOD:-}"
  local version="${HARNERY_VERSION:-}"
  local prefix="${HARNERY_INSTALL_DIR:-}"
  local source="${HARNERY_INSTALL_SOURCE:-}"
  local install_runtime=0
  local dry_run=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --method) method="$2"; shift 2 ;;
      --version) version="$2"; shift 2 ;;
      --prefix) prefix="$2"; shift 2 ;;
      --install-runtime) install_runtime=1; shift ;;
      --dry-run) dry_run=1; shift ;;
      -h | --help) show_help; exit 0 ;;
      *) echo "harnery install: unknown argument '$1' (try --help)" >&2; exit 1 ;;
    esac
  done

  # ── pick a package manager: explicit flag, else npm-preferred, else bun ─────
  if [ -z "$method" ]; then
    if have npm; then
      method=npm
    elif have bun; then
      method=bun
    fi
  fi

  # ── no runtime at all: instruct and exit, unless --install-runtime ──────────
  if [ -z "$method" ]; then
    if [ "$install_runtime" -eq 1 ]; then
      echo "→ no Bun or Node found; installing Bun (https://bun.sh) ..."
      if [ "$dry_run" -eq 0 ]; then
        curl -fsSL https://bun.sh/install | bash
        export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
        export PATH="$BUN_INSTALL/bin:$PATH"
        have bun || {
          echo "harnery install: Bun installed but isn't on PATH yet; open a new shell and re-run." >&2
          exit 1
        }
      fi
      method=bun
    else
      cat >&2 <<EOF
harnery needs Node 20+ or Bun to run, and neither was found.

Install one, then re-run this installer:
  - Bun (recommended):  curl -fsSL https://bun.sh/install | bash
  - Node 20+:           https://nodejs.org  (or your OS package manager)

Or let this script install Bun for you:
  curl -fsSL https://harnery.com/install.sh | bash -s -- --install-runtime
EOF
      exit 1
    fi
  fi

  # ── what to install: explicit source > pinned version > latest ─────────────
  local spec
  if [ -n "$source" ]; then
    spec="$source"
  elif [ -n "$version" ]; then
    spec="${PKG}@${version}"
  else
    spec="${PKG}@latest"
  fi

  echo "harnery installer"
  echo "  package : $spec"
  echo "  method  : $method"
  [ -n "$prefix" ] && echo "  prefix  : $prefix"
  echo

  # ── install ─────────────────────────────────────────────────────────────────
  case "$method" in
    npm)
      if [ -n "$prefix" ]; then
        run "$dry_run" npm install -g --prefix "$prefix" "$spec"
      else
        run "$dry_run" npm install -g "$spec"
      fi
      ;;
    bun)
      if [ -n "$prefix" ]; then
        run "$dry_run" env "BUN_INSTALL=$prefix" bun add -g "$spec"
      else
        run "$dry_run" bun add -g "$spec"
      fi
      ;;
    *)
      echo "harnery install: unknown method '$method' (expected npm|bun)" >&2
      exit 1
      ;;
  esac

  if [ "$dry_run" -eq 1 ]; then
    echo
    echo "Dry run: nothing installed."
    exit 0
  fi

  # ── locate the installed bin, verify, and PATH-check ───────────────────────
  local bindir harn
  bindir="$(global_bindir "$method" "$prefix")"
  harn="$bindir/harn"

  echo
  if [ -x "$harn" ]; then
    echo "✓ installed $("$harn" --version 2>/dev/null || echo "$PKG") → $harn"
  elif have harn; then
    harn="$(command -v harn)"
    bindir="$(dirname "$harn")"
    echo "✓ installed $(harn --version 2>/dev/null || echo "$PKG") → $harn"
  else
    echo "harnery install: the package installed, but I couldn't find the 'harn'" >&2
    echo "binary under $bindir. Check your package manager's global bin directory." >&2
    exit 1
  fi

  case ":$PATH:" in
    *":$bindir:"*) : ;;
    *)
      echo "  ! $bindir isn't on your PATH yet. Add it, then restart your shell:"
      echo "      export PATH=\"$bindir:\$PATH\""
      ;;
  esac

  echo
  echo "Next: wire a project →  harn init"
  echo "Docs https://harnery.com  ·  Uninstall: curl -fsSL https://harnery.com/uninstall.sh | bash"
}

# echo a command, then run it unless this is a dry run ($1 = dry_run flag).
run() {
  local dry="$1"; shift
  echo "+ $*"
  [ "$dry" -eq 1 ] && return 0
  "$@"
}

# Resolve a package manager's global bin directory ($1 = method, $2 = prefix).
global_bindir() {
  local method="$1" prefix="$2"
  case "$method" in
    npm)
      if [ -n "$prefix" ]; then echo "$prefix/bin"; else echo "$(npm prefix -g 2>/dev/null)/bin"; fi
      ;;
    bun)
      echo "${prefix:-${BUN_INSTALL:-$HOME/.bun}}/bin"
      ;;
  esac
}

# Call main last so a truncated download (curl | bash) can't run a partial script.
main "$@"
