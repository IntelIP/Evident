import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function repositoryFile(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Buildkite runs bounded pull-request quality gates on the included macOS queue", async () => {
  const [pipeline, productValidation, fallow, packageCheck, gitToolchain] = await Promise.all([
    repositoryFile(".buildkite/pipeline.yml"),
    repositoryFile(".buildkite/scripts/product-validation.sh"),
    repositoryFile(".buildkite/scripts/fallow.sh"),
    repositoryFile(".buildkite/scripts/package.sh"),
    repositoryFile(".buildkite/scripts/use-modern-git.sh"),
  ]);

  assert.match(pipeline, /queue: "macos-medium"/);
  assert.match(pipeline, /key: "repository-check"/);
  assert.match(pipeline, /key: "fallow"/);
  assert.match(pipeline, /key: "package"/);
  assert.match(pipeline, /key: "product-validation"/);
  assert.doesNotMatch(pipeline, /linux-small/);
  assert.doesNotMatch(pipeline, /git-toolchain/);
  assert.doesNotMatch(pipeline, /BUILDKITE_GITHUB_EVENT/);
  assert.equal(
    pipeline.match(/build\.pull_request\.id != null/g)?.length,
    4,
  );
  assert.match(
    pipeline,
    /build\.env\("TABELLIO_BUILD_CONTEXT"\) == "preflight"/,
  );
  assert.match(pipeline, /build\.branch == pipeline\.default_branch/);

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
  assert.match(packageCheck, /npm pack --dry-run --json/);
  assert.match(packageCheck, /forgejo\|change-request-provider/);
  assert.match(gitToolchain, /required_version="2\.50\.1"/);
  assert.match(gitToolchain, /git version/);
  assert.match(gitToolchain, /awk -v actual=/);
  assert.doesNotMatch(gitToolchain, /buildkite-agent artifact download/);
  assert.doesNotMatch(gitToolchain, /apt-get/);
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
