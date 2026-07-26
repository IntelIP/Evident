#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { createGitCommitContainmentResolver } from "./lib/git-commit-containment.mjs";
import { linkGitHubReleases } from "./lib/github-release-linker.mjs";
import { assertOutputBoundary } from "./lib/output-boundary.mjs";

main().catch(reportCliError);

async function main() {
  const options = parseCommandOptions(process.argv.slice(2), {
    link: ["providerSnapshot", "githubReleaseSnapshot", "repo", "out"],
  });
  requireOptions(options, ["providerSnapshot", "githubReleaseSnapshot", "out"], "link");
  await assertOutputBoundary({
    outputs: [options.out], protectedInputs: [options.providerSnapshot, options.githubReleaseSnapshot],
    duplicatePathMessage: "--out must identify one output path.", symbolicLinkMessage: "--out must not be a symbolic link.",
    outputAliasMessage: "--out must identify one output file.", inputAliasMessage: "--out must not alias an input snapshot.",
    protectedRootMessage: "--out must not be inside a protected input root.",
  });
  const providerPath = resolve(options.providerSnapshot);
  const releasePath = resolve(options.githubReleaseSnapshot);
  const outputPath = resolve(options.out);
  const [providerSnapshot, releaseSnapshot] = await Promise.all([
    readJson(providerPath),
    readJson(releasePath),
  ]);
  const containsCommit = await createGitCommitContainmentResolver({ repo: resolve(options.repo ?? "."), expectedRepository: providerSnapshot.repository });
  const linked = await linkGitHubReleases({ providerSnapshot, releaseSnapshot, containsCommit });
  await writeFile(outputPath, `${JSON.stringify(linked, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    status: "github_releases_linked",
    repository: linked.repository,
    linkedReleaseCount: linked.deliveryChanges.filter((change) => change.releasedAt).length,
    out: outputPath,
  }, null, 2));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
