#!/usr/bin/env bash
set -euo pipefail

. .buildkite/scripts/use-modern-git.sh

candidate="${BUILDKITE_COMMIT:-HEAD}"
base_branch="${BUILDKITE_PULL_REQUEST_BASE_BRANCH:-main}"
base_ref="origin/${base_branch}"
checkpoint_args=()

git fetch --no-tags origin "+refs/heads/${base_branch}:refs/remotes/origin/${base_branch}"
test "$(git rev-parse HEAD^{commit})" = "$(git rev-parse "${candidate}^{commit}")"

if [[ "${BUILDKITE_PULL_REQUEST:-false}" == "false" && "$base_branch" == "main" ]]; then
  base_ref="HEAD^"
  subject="$(git show -s --format=%s HEAD)"
  if [[ "$subject" =~ \(#([0-9]+)\)$ ]]; then
    pull_request="${BASH_REMATCH[1]}"
    checkpoint_ref="refs/tabellio/checkpoints/${pull_request}"
    if git fetch --no-tags origin "+refs/pull/${pull_request}/head:${checkpoint_ref}"; then
      checkpoint_head="$(git rev-parse "${checkpoint_ref}^{commit}")"
      checkpoint_args=(--checkpoint-base "$base_ref" --checkpoint-head "$checkpoint_head")
    fi
  fi
fi

validator_dir="$(mktemp -d)"
trap 'rm -rf "$validator_dir"' EXIT
install -m 755 scripts/tabellio-validator.mjs "$validator_dir/tabellio-validator"

set -o pipefail
PATH="$validator_dir:$PATH" node scripts/tabellio-validate.mjs gate \
  --repo . \
  --repo-id IntelIP/Tabellio \
  --base "$base_ref" \
  --commit HEAD \
  "${checkpoint_args[@]}" \
  --manifest tabellio.validation.json \
  | tee tabellio-validation-result.json
