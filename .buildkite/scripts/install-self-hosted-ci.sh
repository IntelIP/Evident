#!/bin/sh
set -euo pipefail

apk add --no-cache bash curl git jq >/dev/null
git config --global --add safe.directory "$PWD"

node -e '
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(major) || major < 20) process.exit(1);
'
