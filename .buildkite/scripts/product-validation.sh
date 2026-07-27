#!/usr/bin/env bash
set -euo pipefail

build_context="${TABELLIO_BUILD_CONTEXT:-provider}"
if [[ "${BUILDKITE_PULL_REQUEST:-false}" == "false" && "$build_context" != "preflight" ]]; then
  printf '%s\n' "Buildkite product validation requires a pull-request or explicit preflight build." >&2
  exit 2
fi

. .buildkite/scripts/use-modern-git.sh

candidate="${BUILDKITE_COMMIT:-HEAD}"
base_branch="${BUILDKITE_PULL_REQUEST_BASE_BRANCH:-${TABELLIO_BASE_BRANCH:-main}}"
base_ref="origin/${base_branch}"

git fetch --no-tags origin "+refs/heads/${base_branch}:refs/remotes/origin/${base_branch}"
test "$(git rev-parse HEAD^{commit})" = "$(git rev-parse "${candidate}^{commit}")"

validator_dir="$(mktemp -d)"
trap 'rm -rf "$validator_dir"' EXIT
install -m 755 scripts/tabellio-validator.mjs "$validator_dir/tabellio-validator"

PATH="$validator_dir:$PATH" node scripts/tabellio-validate.mjs gate \
  --repo . \
  --repo-id IntelIP/Tabellio \
  --base "$base_ref" \
  --commit HEAD \
  --manifest tabellio.validation.json \
  | tee tabellio-validation-result.json

validation_ref="refs/tabellio/validations"
validation_commit="$(git rev-parse "${validation_ref}^{commit}")"
mkdir -p .artifacts/tabellio
git bundle create .artifacts/tabellio/validation-ref.bundle "$validation_ref"
printf '%s\n' "$validation_commit" > .artifacts/tabellio/validation-ref.sha
git bundle verify .artifacts/tabellio/validation-ref.bundle
