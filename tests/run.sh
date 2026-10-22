#!/bin/sh
# Runs every test file. No install step, no dependencies: the tests use only Node
# built-ins plus the `git` binary that the plugin itself requires.
#
#   sh tests/run.sh
#
# Exits non-zero if any file fails, so it can be dropped into CI as-is.

set -u

cd "$(dirname "$0")" || exit 1

command -v node >/dev/null 2>&1 || { echo "node is required but was not found on PATH"; exit 1; }
command -v git  >/dev/null 2>&1 || { echo "git is required but was not found on PATH"; exit 1; }

# The real thing, not a mock: every failure mode that matters here (a merge that
# silently conflicts, a push that runs before the pull) is invisible to a stubbed
# git, so the tests create actual repositories and a bare remote.
fail=0
for f in sync settings credentials safety scope; do
  printf '%-14s' "$f"
  if out=$(node "$f.test.js" 2>&1); then
    printf '%s\n' "$(printf '%s' "$out" | tail -1)"
  else
    printf 'FAILED\n'
    printf '%s\n' "$out" | sed 's/^/    /'
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "all passed"
else
  echo "there were failures"
fi
exit "$fail"
