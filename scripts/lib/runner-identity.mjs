import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { runGit } from "./git-process.mjs";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function tabellioRunnerIdentity({ root = DEFAULT_ROOT } = {}) {
  const packageMetadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const packageName = requiredString(packageMetadata.name, "package name");
  const packageVersion = requiredString(packageMetadata.version, "package version");
  const source = await gitSourceIdentity(root, packageVersion);
  return {
    packageName,
    packageVersion,
    sourceCommit: source.commit,
    sourceDirty: source.dirty,
    releaseTag: source.releaseTag,
  };
}

async function gitSourceIdentity(root, packageVersion) {
  try {
    return await readGitSourceIdentity(root, packageVersion);
  } catch (error) {
    if (isNotGitRepository(error)) return { commit: null, dirty: null, releaseTag: null };
    throw error;
  }
}

async function readGitSourceIdentity(root, packageVersion) {
  const revision = await runGit({ args: ["rev-parse", "HEAD"], cwd: root });
  const commit = revision.stdout.trim();
  assertGitObjectId(commit);
  const status = await runGit({
    args: ["status", "--porcelain=v1", "--untracked-files=normal"],
    cwd: root,
  });
  const tags = await runGit({
    args: ["tag", "--points-at", commit, "--list", `v${packageVersion}`],
    cwd: root,
  });
  return {
    commit,
    dirty: status.stdout.length > 0,
    releaseTag: matchingReleaseTag(tags.stdout),
  };
}

function assertGitObjectId(value) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error("Tabellio source commit is not a Git object ID.");
  }
}

function matchingReleaseTag(stdout) {
  const tags = stdout.split("\n").map((value) => value.trim()).filter(Boolean);
  return tags.length === 1 ? tags[0] : null;
}

function isNotGitRepository(error) {
  if (!(error instanceof Error)) return false;
  const diagnostic = typeof error.stderr === "string" ? error.stderr : error.message;
  return /not a git repository|must be run in a work tree|unknown revision/i.test(diagnostic);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}
