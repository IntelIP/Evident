#!/usr/bin/env bash
set -euo pipefail

version="2.50.1"
artifact=".artifacts/toolchain/git-${version}-linux-amd64.tar.gz"
install_root="/tmp/intelip-tabellio-git-${version}"

buildkite-agent artifact download "$artifact" .
rm -rf "$install_root"
mkdir -p "$install_root"
tar -C "$install_root" -xzf "$artifact"

export PATH="${install_root}/bin:${PATH}"
export GIT_EXEC_PATH="${install_root}/libexec/git-core"
export GIT_TEMPLATE_DIR="${install_root}/share/git-core/templates"
export GITPERLLIB="${install_root}/share/perl5"
git --version
