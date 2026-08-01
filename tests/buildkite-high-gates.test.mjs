import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function repositoryFile(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Buildkite adds bounded pull-request quality gates without CI cutover", async () => {
  const [pipeline, productValidation, repositoryCheck, fallow, packageCheck, gitToolchain] = await Promise.all([
    repositoryFile(".buildkite/pipeline.yml"),
    repositoryFile(".buildkite/scripts/product-validation.sh"),
    repositoryFile(".buildkite/scripts/tests.sh"),
    repositoryFile(".buildkite/scripts/fallow.sh"),
    repositoryFile(".buildkite/scripts/package.sh"),
    repositoryFile(".buildkite/scripts/verify-git-toolchain.sh"),
  ]);

  assert.match(pipeline, /key: "repository-check"/);
  assert.match(pipeline, /key: "fallow"/);
  assert.match(pipeline, /key: "package"/);
  assert.match(pipeline, /key: "product-validation"/);
  assert.match(pipeline, /^agents:\n  queue: "macos-medium"$/m);
  assert.doesNotMatch(pipeline, /queue: "linux-small"/);
  assert.doesNotMatch(pipeline, /linux-amd64/);
  assert.doesNotMatch(pipeline, /build-modern-git/);
  assert.doesNotMatch(pipeline, /BUILDKITE_GITHUB_EVENT/);
  assert.doesNotMatch(pipeline, /build\.pull_request\.id/);
  assert.doesNotMatch(pipeline, /build\.env\("BUILDKITE_PULL_REQUEST"\)/);
  assert.doesNotMatch(pipeline, /^\s+if:/m);

  assert.doesNotMatch(productValidation, /git show -s --format=%s/);
  assertMatches(productValidation, [
    /BUILDKITE_COMMIT:-HEAD/,
    /default-branch build/,
    /TABELLIO_BUILD_CONTEXT:-provider/,
    /TABELLIO_BASE_BRANCH:-main/,
    /set -euo pipefail/,
    /exit 2/,
    /test "\$\(git rev-parse HEAD\^\{commit\}\)"/,
    /git bundle create .*validation-ref\.bundle/,
    /git bundle verify .*validation-ref\.bundle/,
    /commits\/\$\{candidate\}\/pulls/,
    /scripts\/resolve-merged-checkpoint\.mjs/,
    /Merged checkpoint resolution failed/,
    /Merged checkpoint fetch failed/,
    /fetched_checkpoint_head/,
    /resolved_checkpoint_head/,
    /--checkpoint-head/,
    /github_header_file/,
    /umask 077/,
  ]);
  assert.doesNotMatch(
    productValidation,
    /github_headers\+=\(-H "Authorization: Bearer \$\{BUILDKITE_GITHUB_TOKEN\}"/,
  );

  assert.match(fallow, /fallow@2\.89\.0/);
  assert.match(fallow, /--gate new-only/);
  assert.match(repositoryCheck, /\.buildkite\/scripts\/verify-git-toolchain\.sh/);
  assert.match(fallow, /\.buildkite\/scripts\/verify-git-toolchain\.sh/);
  assert.match(productValidation, /\.buildkite\/scripts\/verify-git-toolchain\.sh/);
  assert.match(packageCheck, /npm pack --dry-run --json/);
  assert.match(packageCheck, /forgejo\|change-request-provider/);
  assert.match(gitToolchain, /required_version="2\.50\.1"/);
  assert.match(gitToolchain, /actual_version="\$\(git version \| awk/);
  assert.match(gitToolchain, /actual_version.*required_version/);
  assert.doesNotMatch(gitToolchain, /apt-get|dpkg-query|linux-amd64|uname/);
});

function assertMatches(value, patterns) {
  patterns.forEach((pattern) => assert.match(value, pattern));
}

test("GitHub merged-head validation remains during Buildkite migration", async () => {
  const workflow = await repositoryFile(".github/workflows/product-validation.yml");

  assert.match(workflow, /commits\/\$MERGED_COMMIT\/pulls/);
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /scripts\/resolve-merged-checkpoint\.mjs/);
});
