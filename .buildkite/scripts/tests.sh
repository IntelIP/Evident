#!/usr/bin/env bash
set -euo pipefail

. .buildkite/scripts/verify-git-toolchain.sh
. .buildkite/scripts/security-tools.sh
npm run check
node scripts/write-tabellio-evidence-envelope.mjs --out tabellio-pr-evidence.json
node scripts/check-tabellio-evidence-envelope.mjs --evidence tabellio-pr-evidence.json
node scripts/check-tabellio-external-actions.mjs --evidence tabellio-pr-evidence.json
