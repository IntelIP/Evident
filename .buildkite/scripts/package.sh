#!/usr/bin/env bash
set -euo pipefail

npm pack --dry-run --json > package-dry-run.json
jq '.[0] | {id, size, unpackedSize, entryCount}' package-dry-run.json
jq -e '
  length == 1 and
  ([.[0].files[].path | select(test("forgejo|change-request-provider"; "i"))] | length == 0)
' package-dry-run.json >/dev/null
