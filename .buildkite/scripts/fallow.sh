#!/usr/bin/env bash
set -euo pipefail

if [[ "${BUILDKITE_PULL_REQUEST:-false}" == "false" ]]; then
  printf '%s\n' '{"kind":"audit","verdict":"pass","decision":"not_required","reason":"changed-code audit runs on pull requests."}' > fallow-audit.json
  exit 0
fi

base_branch="${BUILDKITE_PULL_REQUEST_BASE_BRANCH:-main}"
git fetch --no-tags origin "+refs/heads/${base_branch}:refs/remotes/origin/${base_branch}"
npm ci
coverage_dir="$(pwd -P)/coverage"
coverage_tmp="${coverage_dir}/tmp"
coverage_tests=(
  tests/analytics.test.mjs
  tests/buildkite-build-collector.test.mjs
  tests/delivery-evidence-joiner.test.mjs
  tests/delivery-report.test.mjs
  tests/deployment-cli.test.mjs
  tests/deployment-provider-collector.test.mjs
  tests/deployment-receipt.test.mjs
  tests/github-release-cli.test.mjs
  tests/github-release-collector.test.mjs
  tests/github-release-linker.test.mjs
  tests/istanbul-coverage-normalizer.test.mjs
  tests/plane-work-item-collector.test.mjs
)
rm -rf "$coverage_dir"
mkdir -p "$coverage_tmp"
NODE_V8_COVERAGE="$coverage_tmp" node --test "${coverage_tests[@]}"
./node_modules/.bin/c8 report \
  --temp-directory "$coverage_tmp" \
  --reports-dir "$coverage_dir" \
  --reporter=json
node .buildkite/scripts/normalize-istanbul-coverage.mjs \
  "$coverage_dir/coverage-final.json" \
  "$coverage_dir/coverage-final.fallow.json"
test -s "$coverage_dir/coverage-final.fallow.json"
npm install --global fallow@2.89.0

FALLOW_AGENT_SOURCE=codex fallow audit \
  --base "origin/${base_branch}" \
  --gate new-only \
  --health-baseline quality-baselines/fallow-health.json \
  --dupes-baseline quality-baselines/fallow-dupes.json \
  --coverage "$coverage_dir/coverage-final.fallow.json" \
  --coverage-root "$PWD" \
  --format json \
  --quiet \
  --explain \
  > fallow-audit.json 2>/dev/null || true

jq '{verdict, attribution, summary}' fallow-audit.json
jq -e '.kind == "audit" and .verdict == "pass"' fallow-audit.json >/dev/null
