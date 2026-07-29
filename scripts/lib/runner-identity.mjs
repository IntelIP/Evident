import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { runGit } from "./git-process.mjs";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function tabellioRunnerIdentity({ root = DEFAULT_ROOT } = {}) {
  return (await tabellioRunnerState({ root })).identity;
}

export async function tabellioRunnerState({ root = DEFAULT_ROOT } = {}) {
  const packageMetadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const packageName = requiredString(packageMetadata.name, "package name");
  const packageVersion = requiredString(packageMetadata.version, "package version");
  const source = await gitSourceIdentity(root, packageVersion);
  const identity = {
    packageName,
    packageVersion,
    sourceCommit: source.commit,
    sourceDirty: source.dirty,
    releaseTag: source.releaseTag,
  };
  return { identity, fingerprint: source.fingerprint ?? identityFingerprint(identity) };
}

async function gitSourceIdentity(root, packageVersion) {
  try {
    return await readGitSourceIdentity(root, packageVersion);
  } catch (error) {
    if (isNotGitRepository(error)) return { commit: null, dirty: null, releaseTag: null, fingerprint: null };
    throw error;
  }
}

async function readGitSourceIdentity(root, packageVersion) {
  const worktree = await readGit(root, ["rev-parse", "--show-toplevel"]);
  if (await realpath(worktree.stdout.trim()) !== await realpath(root)) {
    return { commit: null, dirty: null, releaseTag: null };
  }
  const revision = await readGit(root, ["rev-parse", "HEAD"]);
  const commit = revision.stdout.trim();
  assertGitObjectId(commit);
  const status = await readGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const tags = await readGit(root, ["tag", "--points-at", commit, "--list", `v${packageVersion}`]);
  return {
    commit,
    dirty: status.stdout.length > 0,
    releaseTag: matchingReleaseTag(tags.stdout),
    fingerprint: await worktreeFingerprint(root, commit, status.stdout),
  };
}

async function worktreeFingerprint(root, commit, status) {
  const changed = await readGit(root, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"]);
  return fingerprintPaths(root, commit, status, changed.stdout);
}

async function fingerprintPaths(root, commit, status, changed) {
  const untracked = await readGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const hash = createHash("sha256");
  hash.update(commit).update("\0").update(status).update("\0");
  const paths = new Set([...changed.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean));
  for (const path of [...paths].sort()) {
    hash.update(path).update("\0").update(await entryFingerprint(root, path)).update("\0");
  }
  return hash.digest("hex");
}

async function entryFingerprint(root, path) {
  const absolute = resolve(root, path);
  const metadata = await lstat(absolute).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return "missing";
  if (metadata.isFile()) return fileFingerprint(root, path);
  return nonFileFingerprint(absolute, metadata);
}

async function fileFingerprint(root, path) {
  const result = await readGit(root, ["hash-object", "--no-filters", "--", path]).catch((error) => {
    if (isMissingFile(error)) return null;
    throw error;
  });
  if (result === null) return "missing";
  const object = result.stdout.trim();
  assertGitObjectId(object);
  return `file:${object}`;
}

async function nonFileFingerprint(path, metadata) {
  if (metadata.isSymbolicLink()) return `symlink:${await readlink(path)}`;
  if (metadata.isDirectory()) return directoryFingerprint(path);
  return `special:${metadata.mode}`;
}

async function directoryFingerprint(path) {
  const repository = await readGit(path, ["rev-parse", "--is-inside-work-tree"]).catch((error) => {
    if (isNotGitRepository(error)) return null;
    throw error;
  });
  if (repository?.stdout.trim() !== "true") return "directory";
  const revision = await readGit(path, ["rev-parse", "HEAD"]).catch((error) => {
    if (isUnknownRevision(error)) return null;
    throw error;
  });
  const status = await readGit(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const fingerprint = revision === null
    ? await fingerprintPaths(path, "unborn", status.stdout, "")
    : await worktreeFingerprint(path, revision.stdout.trim(), status.stdout);
  return `repository:${fingerprint}`;
}

function readGit(root, args) {
  return runGit({ args, cwd: root, env: { GIT_OPTIONAL_LOCKS: "0" } });
}

function isMissingFile(error) {
  return error instanceof Error && /could not open .*: No such file or directory/.test(error.stderr ?? "");
}

function isUnknownRevision(error) {
  return error instanceof Error && /unknown revision|ambiguous argument 'HEAD'|Needed a single revision/.test(error.stderr ?? "");
}

function identityFingerprint(identity) {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
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
