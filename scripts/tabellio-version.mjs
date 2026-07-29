#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runGit } from "./lib/git-process.mjs";
import { assertAllowedOptions, parseOptionPairs } from "./lib/cli-options.mjs";
import { tabellioRunnerIdentity } from "./lib/runner-identity.mjs";
import { verifyPublishedRunnerRelease } from "./lib/runner-release.mjs";

const BOOLEAN_FLAGS = new Set(["--require-clean", "--require-release-tag"]);
const ALLOWED_OPTIONS = ["expectVersion", "expectRef", "requireClean", "requireReleaseTag"];
const RUNNER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const options = parseArgs(process.argv.slice(2));
  const identity = await tabellioRunnerIdentity({ root: RUNNER_ROOT });
  const expectedCommit = options.expectRef
    ? verifiedCommit((await runGit({
      args: ["rev-parse", "--verify", "--end-of-options", `${options.expectRef}^{commit}`],
      cwd: RUNNER_ROOT,
    })).stdout.trim())
    : null;
  const blockers = [];
  if (options.expectVersion && identity.packageVersion !== options.expectVersion) {
    blockers.push(`package_version_mismatch:${options.expectVersion}`);
  }
  if (expectedCommit && identity.sourceCommit !== expectedCommit) {
    blockers.push(`source_commit_mismatch:${expectedCommit}`);
  }
  if (options.requireClean && identity.sourceDirty !== false) blockers.push("runner_source_not_clean");
  const publishedRelease = options.requireReleaseTag
    ? await verifyPublishedRunnerRelease({ root: RUNNER_ROOT, identity })
    : false;
  if (options.requireReleaseTag && !publishedRelease) {
    blockers.push(`published_release_missing:v${identity.packageVersion}`);
  }
  const status = identity.sourceCommit === null
    ? "source_unavailable"
    : identity.sourceDirty
      ? "dirty"
      : publishedRelease
        ? "released"
        : identity.releaseTag
          ? "tagged"
        : "identified";
  const result = { ok: blockers.length === 0, status, runner: identity, blockers };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    status: "blocked",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
}

function verifiedCommit(value) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error("Expected ref did not resolve to a Git commit.");
  }
  return value;
}

function parseArgs(args) {
  const pairedArgs = args.flatMap((argument) => BOOLEAN_FLAGS.has(argument) ? [argument, "true"] : [argument]);
  const values = parseOptionPairs(pairedArgs, "tabellio-version");
  assertAllowedOptions(values, ALLOWED_OPTIONS);
  return {
    expectVersion: values.expectVersion ?? null,
    expectRef: values.expectRef ?? null,
    requireClean: values.requireClean === "true",
    requireReleaseTag: values.requireReleaseTag === "true",
  };
}
