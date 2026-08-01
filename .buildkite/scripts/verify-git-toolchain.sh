#!/usr/bin/env bash
set -euo pipefail

required_version="2.50.1"
actual_version="$(git version | awk '{ print $3 }')"

if [[ "$actual_version" != "$required_version" ]]; then
  printf 'Tabellio CI requires Git %s; found %s.\n' "$required_version" "$actual_version" >&2
  exit 1
fi

git version
