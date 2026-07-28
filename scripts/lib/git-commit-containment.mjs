import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseGitHubRepositoryRemote } from "./github-repository.mjs";

const execFileAsync = promisify(execFile);
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export async function createGitCommitContainmentResolver({
  repo,
  expectedRepository,
  execute = execFileAsync,
}) {
  if (typeof expectedRepository !== "string") {
    throw new Error("Release-link repository identity mismatch.");
  }
  const { stdout } = await execute(
    "git",
    ["-C", repo, "remote", "get-url", "origin"],
    { encoding: "utf8" },
  );
  const actualRepository = parseGitHubRepositoryRemote(stdout.trim());
  if (
    !actualRepository
    || actualRepository.fullName.toLowerCase() !== expectedRepository.toLowerCase()
  ) {
    throw new Error("Release-link repository identity mismatch.");
  }
  return verifyCommitContainment.bind(null, { repo, execute });
}

async function verifyCommitContainment({ repo, execute }, ancestor, descendant) {
  if (!validCommitPair(ancestor, descendant)) return false;
  if (!await bothCommitsExist({ repo, execute }, ancestor, descendant)) return false;
  try {
    await execute("git", [
      "-C",
      repo,
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ]);
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw new Error("Release commit containment could not be verified.");
  }
}

function validCommitPair(ancestor, descendant) {
  return OID.test(ancestor ?? "") && OID.test(descendant ?? "");
}

async function bothCommitsExist(context, ancestor, descendant) {
  const [ancestorExists, descendantExists] = await Promise.all([
    commitExists(context, ancestor),
    commitExists(context, descendant),
  ]);
  return ancestorExists && descendantExists;
}

async function commitExists({ repo, execute }, commit) {
  try {
    await execute("git", ["-C", repo, "cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch (error) {
    if (error?.code === 1 || error?.code === 128) return false;
    throw new Error("Release commit containment could not be verified.");
  }
}
