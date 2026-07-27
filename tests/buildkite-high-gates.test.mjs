import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function repositoryFile(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Buildkite adds bounded pull-request quality gates without CI cutover", async () => {
  const [pipeline, productValidation, fallow, packageCheck] = await Promise.all([
    repositoryFile(".buildkite/pipeline.yml"),
    repositoryFile(".buildkite/scripts/product-validation.sh"),
    repositoryFile(".buildkite/scripts/fallow.sh"),
    repositoryFile(".buildkite/scripts/package.sh"),
  ]);

  assert.match(pipeline, /key: "repository-check"/);
  assert.match(pipeline, /key: "fallow"/);
  assert.match(pipeline, /key: "package"/);
  assert.match(pipeline, /key: "product-validation"/);
  assert.doesNotMatch(pipeline, /build\.pull_request\.id/);
  assert.match(
    pipeline,
    /if: build\.env\("BUILDKITE_GITHUB_EVENT"\) == "pull_request"/,
  );
  assert.match(pipeline, /build\.branch == pipeline\.default_branch/);

  assert.doesNotMatch(productValidation, /git show -s --format=%s/);
  assert.match(productValidation, /BUILDKITE_COMMIT:-HEAD/);
  assert.match(productValidation, /requires a pull-request build/);
  assert.match(productValidation, /exit 2/);
  assert.match(productValidation, /test "\$\(git rev-parse HEAD\^\{commit\}\)"/);
  assert.match(productValidation, /git bundle create .*validation-ref\.bundle/);
  assert.match(productValidation, /git bundle verify .*validation-ref\.bundle/);

  assert.match(fallow, /fallow@2\.89\.0/);
  assert.match(fallow, /--gate new-only/);
  assert.match(packageCheck, /npm pack --dry-run --json/);
  assert.match(packageCheck, /forgejo\|change-request-provider/);
});

test("GitHub merged-head validation remains during Buildkite migration", async () => {
  const workflow = await repositoryFile(".github/workflows/product-validation.yml");

  assert.match(workflow, /commits\/\$MERGED_COMMIT\/pulls/);
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /scripts\/resolve-merged-checkpoint\.mjs/);
});
