#!/usr/bin/env bash
# The vendored block battery is a copy. Prove it still is.
#
# tests/lib/block-battery.json is carve-grammars' table, vendored so this
# grammar is checked against the same shapes as every other Carve grammar. A
# copy that nothing compares is a copy only until someone edits one side, and a
# stale battery here would pass while the language moved.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
local_file="$root/tests/lib/block-battery.json"
upstream="${CARVE_GRAMMARS_DIR:-}"

if [[ -z "$upstream" ]]; then
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  git clone --quiet --depth 1 https://github.com/markup-carve/carve-grammars "$work/cg"
  upstream="$work/cg"
fi

remote_file="$upstream/tests/lib/block-battery.json"
if [[ ! -f "$remote_file" ]]; then
  echo "No block-battery.json in $upstream" >&2
  exit 1
fi

if ! diff -q "$local_file" "$remote_file" >/dev/null; then
  echo "The vendored block battery has drifted from carve-grammars:"
  # `diff` exits 1 when there IS a difference, which under `pipefail` would
  # abort the script here and swallow the remediation line below.
  diff "$local_file" "$remote_file" | head -40 || true
  echo
  echo "Re-copy tests/lib/block-battery.json, then fix whatever the new shapes catch."
  exit 1
fi
printf 'check-battery-drift: %s shape(s) match carve-grammars.\n' \
  "$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['shapes']))" "$local_file")"
