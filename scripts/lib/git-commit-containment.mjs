import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseGitHubRepositoryRemote } from "./github-repository.mjs";

const execFileAsync = promisify(execFile);

export async function createGitCommitContainmentResolver({ repo, expectedRepository, execute = execFileAsync }) {
  if (typeof expectedRepository !== "string") throw new Error("Release-link repository identity mismatch.");
  const { stdout } = await execute("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" });
  const actualRepository = parseGitHubRepositoryRemote(stdout.trim());
  if (!actualRepository || actualRepository.fullName.toLowerCase() !== expectedRepository.toLowerCase()) {
    throw new Error("Release-link repository identity mismatch.");
  }
  return verifyCommitContainment.bind(null, { repo, execute });
}

async function verifyCommitContainment({ repo, execute }, ancestor, descendant) {
  if (ancestor === descendant) return true;
  try {
    await execute("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw new Error("Release commit containment could not be verified.");
  }
}
