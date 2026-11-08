#!/bin/sh
# Runs the workbuddy-pdf CLI for this skill and passes every argument through,
# so the caller sees the CLI's own output and exit code.
#
# The CLI is looked for in this order:
#   1. $WORKBUDDY_PDF
#   2. <skill>/bin/<os>-<arch>/workbuddy-pdf[.exe], the runtime bundled with
#      the skill (os: macos|linux|windows, arch: arm64|x86_64)
#   3. workbuddy-pdf on PATH
# `run.sh --locate` prints the CLI that would run, and runs nothing.
# Exit code 127 means none of the three was found.
set -eu

skill_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

os=$(uname -s 2>/dev/null || echo unknown)
arch=$(uname -m 2>/dev/null || echo unknown)
case "$os" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *) os=$(printf '%s' "$os" | tr '[:upper:]' '[:lower:]') ;;
esac
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x86_64 ;;
esac
exe=workbuddy-pdf
[ "$os" = windows ] && exe=workbuddy-pdf.exe

# A zip that dropped the execute bits leaves the bundle unrunnable, and its
# launcher then reports an incomplete bundle. Restore them before judging it.
make_runnable() {
  for file in "$1" "$(dirname -- "$1")/bin/workbuddy-pdf"; do
    if [ -f "$file" ] && [ ! -x "$file" ]; then
      chmod u+x "$file" 2>/dev/null || true
    fi
  done
}

bundled() {
  if [ -f "$1" ]; then
    make_runnable "$1"
    cli=$1
    return 0
  fi
  return 1
}

cli=
if [ -n "${WORKBUDDY_PDF:-}" ]; then
  if [ ! -f "$WORKBUDDY_PDF" ]; then
    echo "workbuddy-pdf: WORKBUDDY_PDF='$WORKBUDDY_PDF' is not a file" >&2
    exit 127
  fi
  cli=$WORKBUDDY_PDF
else
  # An Apple silicon Mac also runs the Intel build, under Rosetta. Paths are
  # tried one by one: a skill installed under "Application Support" has a
  # space in every one of them.
  bundled "$skill_dir/bin/$os-$arch/$exe" ||
    { [ "$os" = macos ] && [ "$arch" = arm64 ] &&
      bundled "$skill_dir/bin/macos-x86_64/$exe"; } ||
    cli=$(command -v workbuddy-pdf 2>/dev/null || true)
fi

if [ -z "$cli" ]; then
  echo "workbuddy-pdf: CLI not found; looked for \$WORKBUDDY_PDF," \
       "$skill_dir/bin/$os-$arch/$exe, and workbuddy-pdf on PATH" >&2
  exit 127
fi

if [ "${1:-}" = "--locate" ]; then
  printf '%s\n' "$cli"
  exit 0
fi

exec "$cli" "$@"
