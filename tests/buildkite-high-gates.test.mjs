import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function repositoryFile(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function hostGitVersion() {
  const {stdout} = await execFileAsync("git", ["version"]);
  return stdout.match(/^git version (\d+\.\d+\.\d+)/)?.[1] ?? "";
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
  assert.match(pipeline, /tabellio-git-toolchain\.json/);
  assert.match(pipeline, /^agents:\n  queue: "docker-local-pilot"$/m);
  assert.match(pipeline, /node:24-alpine3\.23@sha256:[a-f0-9]{64}/);
  assert.match(pipeline, /concurrency_group: "intelip\/current-projects\/self-hosted"/);
  assert.match(pipeline, /manual:\n\s+allowed: false/);
  assert.doesNotMatch(pipeline, /queue: "macos-medium"/);
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
    /default branch/,
    /TABELLIO_BUILD_CONTEXT:-provider/,
    /TABELLIO_BASE_BRANCH:-main/,
    /set -euo pipefail/,
    /decision":"not_required"/,
    /exit 0/,
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
  assert.match(gitToolchain, /minimum_version="2\.50\.1"/);
  assert.match(gitToolchain, /maximum_version="3\.0\.0"/);
  assert.match(gitToolchain, /actual_version="\$\(git version \| awk/);
  assert.match(gitToolchain, /git bundle create/);
  assert.match(gitToolchain, /git bundle verify/);
  assert.match(gitToolchain, /git merge-base --is-ancestor/);
  assert.match(gitToolchain, /git rev-parse --verify/);
  assert.match(gitToolchain, /architecture/);
  assert.match(gitToolchain, /operating_system/);
  assert.doesNotMatch(gitToolchain, /apt-get|dpkg-query|linux-amd64/);
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

test("Git capability gate accepts the supported range and rejects unsafe bounds", async () => {
  const script = new URL("../.buildkite/scripts/verify-git-toolchain.sh", import.meta.url);
  await execFileAsync("bash", [script.pathname, "--check-version", "2.50.1"]);
  await execFileAsync("bash", [script.pathname, "--check-version", "2.52.0"]);
  await assert.rejects(
    execFileAsync("bash", [script.pathname, "--check-version", "2.49.9"]),
    (error) => error.code === 1 && error.stderr.includes(">=2.50.1 and <3.0.0")
  );
  await assert.rejects(
    execFileAsync("bash", [script.pathname, "--check-version", "3.0.0"]),
    (error) => error.code === 1 && error.stderr.includes(">=2.50.1 and <3.0.0")
  );
});

test("sourced Git capability gate records features and restores caller cleanup state", async (context) => {
  const script = new URL("../.buildkite/scripts/verify-git-toolchain.sh", import.meta.url);
  const hostVersion = await hostGitVersion();
  try {
    await execFileAsync("bash", [script.pathname, "--check-version", hostVersion]);
  } catch {
    context.skip(`host Git ${hostVersion} is outside the supported runtime range`);
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "tabellio-git-source-"));
  const evidence = join(directory, "evidence.json");
  const sourceCheck = [
    "temporary_dir=caller-owned",
    "trap 'true' EXIT",
    "before=\"$(trap -p EXIT)\"",
    `. ${JSON.stringify(script.pathname)}`,
    'test "$temporary_dir" = caller-owned',
    'test "$before" = "$(trap -p EXIT)"',
    `test -f ${JSON.stringify(evidence)}`,
    `test -z "$(find ${JSON.stringify(directory)} -mindepth 1 -type d -print -quit)"`
  ].join("\n");
  try {
    await execFileAsync("bash", ["-c", sourceCheck], {
      cwd: new URL("..", import.meta.url),
      env: {...process.env, TABELLIO_GIT_EVIDENCE_PATH: evidence}
    });
    const record = JSON.parse(await readFile(evidence, "utf8"));
    assert.match(record.gitVersion, /^\d+\.\d+\.\d+$/);
    assert.match(record.architecture, /^[A-Za-z0-9._-]+$/);
    assert.match(record.os, /^[A-Za-z0-9._-]+$/);
    assert.deepEqual(record.capabilities, [
      "bundle-create-verify",
      "merge-base-is-ancestor",
      "rev-parse-commit"
    ]);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
