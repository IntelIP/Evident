#!/usr/bin/env bash
set -euo pipefail

postgres_bin="$(pg_config --bindir)"
test -x "$postgres_bin/initdb"
test -x "$postgres_bin/pg_ctl"
export PATH="$postgres_bin:$PATH"

c8 --exclude '**/node_modules/**' --reporter=json --reports-dir coverage node scripts/demo-provenance.mjs \
  --verify-storage-tests true --out coverage/provenance-demo.json

# Fallow 2.89 consumes function/statement coverage but rejects c8's unknown
# branch-column sentinel (-1). Preserve the original report; omit only branch
# maps in its input, without changing any measured function or statement hits.
jq 'with_entries(.value |= (.branchMap = {} | .b = {}))' \
  coverage/coverage-final.json > coverage/fallow-coverage.json
