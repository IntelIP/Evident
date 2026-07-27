#!/usr/bin/env bash
set -euo pipefail

. .buildkite/scripts/use-modern-git.sh
npm run check
node scripts/write-tabellio-evidence-envelope.mjs --out tabellio-pr-evidence.json
node scripts/check-tabellio-evidence-envelope.mjs --evidence tabellio-pr-evidence.json
node scripts/check-tabellio-external-actions.mjs --evidence tabellio-pr-evidence.json
