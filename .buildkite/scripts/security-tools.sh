#!/usr/bin/env bash
set -euo pipefail

# Source this script to retain PATH in Buildkite. GitHub receives the same paths
# through its runner environment files. No candidate package scripts are run.
if [[ -n "${TABELLIO_SECURITY_TOOLS_DIR:-}" ]]; then
  security_tools_root="$TABELLIO_SECURITY_TOOLS_DIR"
else
  security_tools_root="$(mktemp -d "${TMPDIR:-/tmp}/tabellio-security-tools.XXXXXX")"
fi
mkdir -p "$security_tools_root"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    security_archive_name="gitleaks_8.30.1_darwin_arm64.tar.gz"
    security_archive_digest="b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"
    ;;
  Linux-x86_64)
    security_archive_name="gitleaks_8.30.1_linux_x64.tar.gz"
    security_archive_digest="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
    ;;
  *) printf '%s\n' 'Unsupported security tool platform.' >&2; exit 1 ;;
esac
security_archive_path="$security_tools_root/$security_archive_name"
if [[ ! -f "$security_archive_path" ]]; then
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 15 --max-time 120 \
    "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/$security_archive_name" \
    --output "$security_archive_path"
fi
node --input-type=module - "$security_archive_path" "$security_archive_digest" <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const actual = createHash('sha256').update(readFileSync(process.argv[2])).digest('hex');
if (actual !== process.argv[3]) throw new Error('Security scanner archive integrity mismatch.');
NODE
tar -xzf "$security_archive_path" -C "$security_tools_root" gitleaks
npm install --prefix "$security_tools_root" --no-save --no-package-lock --ignore-scripts \
  --registry https://registry.npmjs.org @ast-grep/cli@0.45.1
export PATH="$security_tools_root:$security_tools_root/node_modules/.bin:$PATH"
export TABELLIO_GITLEAKS="$security_tools_root/gitleaks"
export TABELLIO_REQUIRE_SECURITY_SCANNERS=1
test "$(gitleaks version)" = "8.30.1"
test "$(ast-grep --version)" = "ast-grep 0.45.1"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$security_tools_root" "$security_tools_root/node_modules/.bin" >> "$GITHUB_PATH"
  printf 'TABELLIO_GITLEAKS=%s\nTABELLIO_REQUIRE_SECURITY_SCANNERS=1\n' "$TABELLIO_GITLEAKS" >> "$GITHUB_ENV"
fi
