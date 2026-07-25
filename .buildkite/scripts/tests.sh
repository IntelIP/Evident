#!/usr/bin/env bash
set -euo pipefail

. .buildkite/scripts/use-modern-git.sh
npm run check
