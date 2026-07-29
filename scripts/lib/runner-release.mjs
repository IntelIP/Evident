import { runExternalCommand } from "./external-command.mjs";
import { effectiveGitHubRepository } from "./github-repository.mjs";
import { runGit } from "./git-process.mjs";

export async function verifyPublishedRunnerRelease({
  root,
  identity,
  remote = "origin",
  ghBinary = "gh",
  commandRunner = runExternalCommand,
  repositoryReader = effectiveGitHubRepository,
  remoteTagReader = readPublishedTag,
} = {}) {
  const tag = `v${identity.packageVersion}`;
  if (!hasLocalTag(identity, tag)) return false;
  const repository = await repositoryReader({ repoPath: root }, remote);
  const remoteTag = await remoteTagReader({ root, remote, tag });
  if (!isExactAnnotatedTag(remoteTag, identity.sourceCommit)) return false;
  const release = await commandRunner({
    binary: ghBinary,
    args: ["release", "view", tag, "--repo", repository.fullName, "--json", "tagName,isDraft,isPrerelease"],
    cwd: root,
    timeoutMs: 30_000,
  });
  return isPublishedRelease(JSON.parse(release.stdout), tag);
}

function hasLocalTag(identity, tag) {
  return identity.sourceCommit !== null && identity.releaseTag === tag;
}

function isExactAnnotatedTag(remoteTag, commit) {
  return remoteTag?.annotated === true && remoteTag.commit === commit;
}

function isPublishedRelease(release, tag) {
  return release.tagName === tag && release.isDraft === false && release.isPrerelease === false;
}

async function readPublishedTag({ root, remote, tag }) {
  const directRef = `refs/tags/${tag}`;
  const peeledRef = `${directRef}^{}`;
  const result = await runGit({
    args: ["ls-remote", "--tags", remote, directRef, peeledRef],
    cwd: root,
    timeoutMs: 30_000,
  });
  const refs = new Map(result.stdout.trim().split(/\r?\n/)
    .filter(Boolean)
    .map((row) => row.split(/\s+/)));
  const direct = refs.get(directRef);
  const commit = refs.get(peeledRef);
  if (!direct || !commit) return null;
  return { annotated: direct !== commit, commit };
}
