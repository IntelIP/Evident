#!/usr/bin/env bash
set -euo pipefail

if [[ "${BUILDKITE_PULL_REQUEST:-false}" == "false" ]]; then
  printf '%s\n' '{"kind":"audit","verdict":"pass","decision":"not_required","reason":"changed-code audit runs on pull requests."}' > fallow-audit.json
  exit 0
fi

base_branch="${BUILDKITE_PULL_REQUEST_BASE_BRANCH:-main}"
git fetch --no-tags origin "+refs/heads/${base_branch}:refs/remotes/origin/${base_branch}"
npm ci
rm -rf coverage
./node_modules/.bin/c8 \
  --temp-directory coverage/tmp \
  --reports-dir coverage \
  --reporter=none \
  node --test tests/*.test.mjs
./node_modules/.bin/c8 report \
  --temp-directory coverage/tmp \
  --reports-dir coverage \
  --reporter=json
node .buildkite/scripts/normalize-istanbul-coverage.mjs \
  coverage/coverage-final.json \
  coverage/coverage-final.fallow.json
test -s coverage/coverage-final.fallow.json
npm install --global fallow@2.89.0

FALLOW_AGENT_SOURCE=codex fallow audit \
  --base "origin/${base_branch}" \
  --gate new-only \
  --health-baseline quality-baselines/fallow-health.json \
  --dupes-baseline quality-baselines/fallow-dupes.json \
  --coverage coverage/coverage-final.fallow.json \
  --coverage-root "$PWD" \
  --format json \
  --quiet \
  --explain \
  > fallow-audit.json 2>/dev/null || true

jq '{verdict, attribution, summary}' fallow-audit.json
jq -e '.kind == "audit" and .verdict == "pass"' fallow-audit.json >/dev/null
