#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { createGitCommitContainmentResolver } from "./lib/git-commit-containment.mjs";
import { linkGitHubReleases } from "./lib/github-release-linker.mjs";
import {
  canonicalCandidatePath,
  pathState,
  sameFile,
} from "./lib/output-safety.mjs";

main().catch(reportCliError);

async function main() {
  const options = parseCommandOptions(process.argv.slice(2), {
    link: ["providerSnapshot", "githubReleaseSnapshot", "repo", "out"],
  });
  requireOptions(
    options,
    ["providerSnapshot", "githubReleaseSnapshot", "out"],
    "link",
  );
  const providerPath = resolve(options.providerSnapshot);
  const releasePath = resolve(options.githubReleaseSnapshot);
  const outputPath = resolve(options.out);
  await assertSafeOutput(outputPath, [providerPath, releasePath]);
  const [providerSnapshot, releaseSnapshot] = await Promise.all([
    readJson(providerPath),
    readJson(releasePath),
  ]);
  const containsCommit = await createGitCommitContainmentResolver({
    repo: resolve(options.repo ?? "."),
    expectedRepository: providerSnapshot.repository,
  });
  const linked = await linkGitHubReleases({
    providerSnapshot,
    releaseSnapshot,
    containsCommit,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(linked, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    status: "github_releases_linked",
    repository: linked.repository,
    linkedReleaseCount: linked.deliveryChanges.filter(
      (change) => change.releasedAt !== null && change.releasedAt !== undefined
    ).length,
    out: outputPath,
  }, null, 2));
}

async function assertSafeOutput(output, inputs) {
  const outputState = await pathState(output);
  assertOutputIsNotSymbolicLink(outputState);
  const inputStates = await Promise.all(inputs.map(pathState));
  assertReadableDirectInputs(inputStates);
  assertNoExistingAlias(outputState, inputStates);
  const outputCandidate = await canonicalCandidatePath(output, outputState);
  if (inputStates.some((state) => state.resolvedPath === outputCandidate)) {
    throw new Error("--out must not alias an input snapshot.");
  }
}

function assertOutputIsNotSymbolicLink(outputState) {
  if (outputState !== null && outputState.symbolicLink) {
    throw new Error("--out must not be a symbolic link.");
  }
}

function assertReadableDirectInputs(inputStates) {
  if (inputStates.some((state) => state === null)) {
    throw new Error("Release-link input snapshot is inaccessible.");
  }
  if (inputStates.some((state) => state.symbolicLink)) {
    throw new Error("Release-link inputs must not be symbolic links.");
  }
}

function assertNoExistingAlias(outputState, inputStates) {
  if (inputStates.some((state) => sameFile(outputState, state))) {
    throw new Error("--out must not alias an input snapshot.");
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
