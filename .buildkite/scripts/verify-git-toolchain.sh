#!/usr/bin/env bash
set -euo pipefail

minimum_version="2.50.1"
maximum_version="3.0.0"

version_number() {
  local version="$1"
  if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    printf 'Tabellio CI requires a semantic Git version; found %s.\n' "$version" >&2
    return 1
  fi
  printf '%09d%09d%09d\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
}

check_supported_version() {
  local version="$1"
  local actual minimum maximum
  actual="$(version_number "$version")" || return 1
  minimum="$(version_number "$minimum_version")"
  maximum="$(version_number "$maximum_version")"
  if [[ "$actual" < "$minimum" || "$actual" > "$maximum" || "$actual" == "$maximum" ]]; then
    printf 'Tabellio CI requires Git >=%s and <%s; found %s.\n' \
      "$minimum_version" "$maximum_version" "$version" >&2
    return 1
  fi
}

if [[ "${1:-}" == "--check-version" ]]; then
  [[ "$#" == 2 ]] || {
    printf '%s\n' "usage: verify-git-toolchain.sh --check-version <version>" >&2
    exit 2
  }
  check_supported_version "$2"
  exit
fi

actual_version="$(git version | awk '{ print $3 }')"
check_supported_version "$actual_version"

head_commit="$(git rev-parse --verify 'HEAD^{commit}')"
git merge-base --is-ancestor "$head_commit" "$head_commit"

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT
git bundle create "$temporary_dir/capability.bundle" --all
git bundle verify "$temporary_dir/capability.bundle" >/dev/null

architecture="$(uname -m)"
operating_system="$(uname -s)"
evidence_path="${TABELLIO_GIT_EVIDENCE_PATH:-tabellio-git-toolchain.json}"
if [[ ! "$architecture" =~ ^[A-Za-z0-9._-]+$ || ! "$operating_system" =~ ^[A-Za-z0-9._-]+$ ]]; then
  printf '%s\n' "Tabellio CI could not record a portable architecture/OS identity." >&2
  exit 1
fi

printf '{"schemaVersion":"tabellio-git-toolchain/v0.1","gitVersion":"%s","architecture":"%s","os":"%s","capabilities":["bundle-create-verify","merge-base-is-ancestor","rev-parse-commit"]}\n' \
  "$actual_version" "$architecture" "$operating_system" > "$evidence_path"
printf 'Git %s supported on %s/%s; required capabilities passed.\n' \
  "$actual_version" "$operating_system" "$architecture"
