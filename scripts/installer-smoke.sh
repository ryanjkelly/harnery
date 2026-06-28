#!/usr/bin/env bash
# CI smoke test for the hosted installer + uninstaller
# (docs/public/install.sh and docs/public/uninstall.sh).
#
#   scripts/installer-smoke.sh --method npm|bun --tarball <path-to.tgz>
#
# It installs a freshly-packed tarball into a throwaway --prefix via the hosted
# installer (HARNERY_INSTALL_SOURCE points it at the local tarball instead of the
# npm registry), asserts `harn` runs, then removes it via the hosted uninstaller
# and asserts it's gone. Playwright's browser download is skipped. Exits non-zero
# on the first failed assertion.

set -euo pipefail

HARNERY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

METHOD=""
TARBALL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --method) METHOD="$2"; shift 2 ;;
    --tarball) TARBALL="$2"; shift 2 ;;
    *) echo "installer-smoke: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

[ -n "$METHOD" ] || { echo "installer-smoke: --method npm|bun is required" >&2; exit 1; }
[ -n "$TARBALL" ] || { echo "installer-smoke: --tarball <path> is required" >&2; exit 1; }
[ -f "$TARBALL" ] || { echo "installer-smoke: tarball not found: $TARBALL" >&2; exit 1; }
# Absolutize the tarball path (the installer runs from elsewhere).
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"

WORK="$(mktemp -d)"
PREFIX="$WORK/prefix"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export HARNERY_INSTALL_SOURCE="$TARBALL"

echo "== installer-smoke ($METHOD) =="

echo "-- install --"
bash "$HARNERY_DIR/docs/public/install.sh" --method "$METHOD" --prefix "$PREFIX"

HARN="$PREFIX/bin/harn"
echo "-- verify --"
[ -x "$HARN" ] || { echo "FAIL: $HARN is not an executable"; exit 1; }
VERSION="$("$HARN" --version)"
echo "harn --version => $VERSION"
[ -n "$VERSION" ] || { echo "FAIL: harn --version produced no output"; exit 1; }
# The CLI boots far enough to run a command (doctor may warn on missing optional
# deps; we only care that it doesn't crash).
"$HARN" doctor --json >/dev/null

echo "-- uninstall --"
bash "$HARNERY_DIR/docs/public/uninstall.sh" --method "$METHOD" --prefix "$PREFIX"
[ -e "$HARN" ] && { echo "FAIL: harn still present after uninstall"; exit 1; }

echo "== installer-smoke ($METHOD) OK =="
