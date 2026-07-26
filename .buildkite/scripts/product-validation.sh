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
  checkpoint_output="$(mktemp)"
  if ! curl --fail --silent --show-error \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/IntelIP/Tabellio/commits/${candidate}/pulls" \
    | node scripts/resolve-merged-checkpoint.mjs --commit "$candidate" --github-output "$checkpoint_output"; then
    rm -f "$checkpoint_output"
    echo "Merged checkpoint resolution failed." >&2
    exit 1
  fi
  pull_request="$(awk -F= '$1 == "number" { print $2 }' "$checkpoint_output")"
  resolved_checkpoint_head="$(awk -F= '$1 == "head" { print $2 }' "$checkpoint_output")"
  if [[ -n "$pull_request" && -n "$resolved_checkpoint_head" ]]; then
    checkpoint_ref="refs/tabellio/checkpoints/${pull_request}"
    if ! git fetch --no-tags origin "+refs/pull/${pull_request}/head:${checkpoint_ref}"; then
      rm -f "$checkpoint_output"
      echo "Merged checkpoint fetch failed." >&2
      exit 1
    fi
    fetched_checkpoint_head="$(git rev-parse "${checkpoint_ref}^{commit}")"
    if [[ "$fetched_checkpoint_head" != "$resolved_checkpoint_head" ]]; then
      rm -f "$checkpoint_output"
      echo "Merged checkpoint identity changed during resolution." >&2
      exit 1
    fi
    checkpoint_args=(--checkpoint-base "$base_ref" --checkpoint-head "$resolved_checkpoint_head")
  fi
  rm -f "$checkpoint_output"
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
