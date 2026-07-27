#!/usr/bin/env bash
set -euo pipefail

. .buildkite/scripts/use-modern-git.sh

build_context="${TABELLIO_BUILD_CONTEXT:-provider}"
if [[ "${BUILDKITE_PULL_REQUEST:-false}" == "false" && "$build_context" != "preflight" ]]; then
  printf '%s\n' '{"kind":"audit","verdict":"pass","decision":"not_required","reason":"changed-code audit runs on pull requests."}' > fallow-audit.json
  exit 0
fi

base_branch="${BUILDKITE_PULL_REQUEST_BASE_BRANCH:-${TABELLIO_BASE_BRANCH:-main}}"
git fetch --no-tags origin "+refs/heads/${base_branch}:refs/remotes/origin/${base_branch}"
npm install --global fallow@2.89.0

FALLOW_AGENT_SOURCE=codex fallow audit \
  --base "origin/${base_branch}" \
  --gate new-only \
  --health-baseline quality-baselines/fallow-health.json \
  --dupes-baseline quality-baselines/fallow-dupes.json \
  --format json \
  --quiet \
  --explain \
  > fallow-audit.json 2>/dev/null || true

jq '{verdict, attribution, summary}' fallow-audit.json
jq -e '.kind == "audit" and .verdict == "pass"' fallow-audit.json >/dev/null
