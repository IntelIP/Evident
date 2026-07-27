import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function repositoryFile(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Buildkite adds bounded pull-request quality gates without CI cutover", async () => {
  const [pipeline, productValidation, fallow, packageCheck, gitToolchain] = await Promise.all([
    repositoryFile(".buildkite/pipeline.yml"),
    repositoryFile(".buildkite/scripts/product-validation.sh"),
    repositoryFile(".buildkite/scripts/fallow.sh"),
    repositoryFile(".buildkite/scripts/package.sh"),
    repositoryFile(".buildkite/scripts/build-modern-git.sh"),
  ]);

  assert.match(pipeline, /key: "repository-check"/);
  assert.match(pipeline, /key: "fallow"/);
  assert.match(pipeline, /key: "package"/);
  assert.match(pipeline, /key: "product-validation"/);
  assert.doesNotMatch(pipeline, /BUILDKITE_GITHUB_EVENT/);
  assert.equal(
    pipeline.match(/build\.pull_request\.id != null/g)?.length,
    5,
  );
  assert.match(
    pipeline,
    /build\.env\("TABELLIO_BUILD_CONTEXT"\) == "preflight"/,
  );
  assert.match(pipeline, /build\.branch == pipeline\.default_branch/);

  assert.doesNotMatch(productValidation, /git show -s --format=%s/);
  assert.match(productValidation, /BUILDKITE_COMMIT:-HEAD/);
  assert.match(productValidation, /explicit preflight build/);
  assert.match(productValidation, /TABELLIO_BUILD_CONTEXT:-provider/);
  assert.match(productValidation, /TABELLIO_BASE_BRANCH:-main/);
  assert.match(productValidation, /set -euo pipefail/);
  assert.match(productValidation, /exit 2/);
  assert.match(productValidation, /test "\$\(git rev-parse HEAD\^\{commit\}\)"/);
  assert.match(productValidation, /git bundle create .*validation-ref\.bundle/);
  assert.match(productValidation, /git bundle verify .*validation-ref\.bundle/);

  assert.match(fallow, /fallow@2\.89\.0/);
  assert.match(fallow, /--gate new-only/);
  assert.match(packageCheck, /npm pack --dry-run --json/);
  assert.match(packageCheck, /forgejo\|change-request-provider/);
  assert.match(gitToolchain, /dpkg-query/);
  assert.match(gitToolchain, /Dir::Etc::sourcelist="\$apt_source_list"/);
  assert.match(gitToolchain, /Dir::Etc::sourceparts="\$apt_source_parts"/);
  assert.match(gitToolchain, /Dir::State::lists="\$apt_lists"/);
  assert.match(gitToolchain, /ubuntu\\\.com/);
  assert.match(gitToolchain, /debian\\\.org/);
  assert.match(gitToolchain, /sources\.list\.d\/ubuntu\.sources/);
  assert.match(gitToolchain, /sources\.list\.d\/debian\.sources/);
  assert.doesNotMatch(gitToolchain, /sources\.list\.d\/\*/);
  assert.equal(gitToolchain.match(/sudo apt-get "\$\{apt_options\[@\]\}"/g)?.length, 2);
  assert.doesNotMatch(gitToolchain, /^\s*sudo apt-get update\s*$/m);
});

test("GitHub merged-head validation remains during Buildkite migration", async () => {
  const workflow = await repositoryFile(".github/workflows/product-validation.yml");

  assert.match(workflow, /commits\/\$MERGED_COMMIT\/pulls/);
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /scripts\/resolve-merged-checkpoint\.mjs/);
});
