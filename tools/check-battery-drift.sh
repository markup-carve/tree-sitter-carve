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
  revision="$(tr -d '[:space:]' < "$root/tools/carve-grammars.rev")"
  git clone --quiet --no-checkout https://github.com/markup-carve/carve-grammars "$work/cg"
  git -C "$work/cg" checkout --quiet --detach "$revision"
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
shapes="$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['shapes']))" "$local_file")"

# Equality is not presence. Two empty tables are identical, and this script's
# whole claim - "still the same copy" - holds over them: emptied on BOTH sides it
# printed "0 shape(s) match carve-grammars" and exited 0
# (markup-carve/carve#755). A shallow clone that half-fetched, a renamed `shapes`
# key upstream, or a table genuinely emptied there all arrive at the same place,
# and the copy this repository runs would be empty with nothing saying so.
if [[ "$shapes" -lt 30 ]]; then
  echo "BATTERY: compared $shapes shape(s) but expected at least 30. A run over" >&2
  echo "fewer than it should have is not a pass - it is a smaller question answered." >&2
  echo "Both copies agreeing on an empty table is not agreement about anything." >&2
  exit 2
fi

printf 'check-battery-drift: %s shape(s) match carve-grammars.\n' "$shapes"
