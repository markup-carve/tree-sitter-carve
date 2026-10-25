#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="0.1.19"
expected="7814b9f0a92deb0aaef8441168085e614fc73690"
tags="$(git ls-remote --tags --refs https://github.com/markup-carve/carve-grammars.git 'refs/tags/v*')"
actual="$(printf '%s\n' "${tags}" | awk -v ref="refs/tags/v${version}" '$2 == ref { print $1 }')"
if [[ "${actual}" != "${expected}" ]]; then
  echo "carve-grammars v${version} no longer resolves to ${expected}" >&2
  exit 1
fi
source_url="https://raw.githubusercontent.com/markup-carve/carve-grammars/v${version}/tests/lib/block-battery.json"
if ! curl -fsSL "${source_url}" | cmp -s - "${root}/tests/lib/block-battery-${version}.json"; then
  echo "the current block battery differs from carve-grammars v${version}" >&2
  exit 1
fi
printf 'pinned block battery matches carve-grammars v%s\n' "${version}"
