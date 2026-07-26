import { validateGitHubReleaseSnapshot } from "./github-release-collector.mjs";
import { validateProviderSnapshot } from "./analytics.mjs";

export async function linkGitHubReleases({ providerSnapshot, releaseSnapshot, containsCommit = sameCommit }) {
  validateGitHubReleaseSnapshot(releaseSnapshot);
  const providerErrors = validateProviderSnapshot(providerSnapshot, providerSnapshot?.repository, laterTimestamp(providerSnapshot?.capturedAt, releaseSnapshot?.capturedAt));
  if (providerErrors.length) throw new Error(`Invalid provider snapshot: ${providerErrors.join("; ")}`);
  if (releaseSnapshot.status !== "available") throw new Error("Cannot link a blocked GitHub release snapshot.");
  if (!sameRepository(providerSnapshot?.repository, releaseSnapshot.repository)) {
    throw new Error("Provider and GitHub release snapshots must name the same repository.");
  }
  if (!Array.isArray(providerSnapshot?.deliveryChanges) || providerSnapshot?.sources?.github?.status !== "available") {
    throw new Error("Provider snapshot requires available GitHub evidence and delivery changes.");
  }
  if (typeof containsCommit !== "function") throw new Error("Release linking requires a commit-containment resolver.");
  const releases = releaseSnapshot.releases
    .filter((release) => release.commitStatus === "resolved")
    .sort((left, right) => Date.parse(left.publishedAt) - Date.parse(right.publishedAt));
  const linked = structuredClone(providerSnapshot);
  linked.capturedAt = laterTimestamp(providerSnapshot.capturedAt, releaseSnapshot.capturedAt);
  linked.sources.github.version = laterTimestamp(providerSnapshot.sources.github.version, releaseSnapshot.capturedAt);
  linked.deliveryChanges = await Promise.all(providerSnapshot.deliveryChanges.map((change) => linkChange(change, releases, containsCommit)));
  return linked;
}

async function linkChange(change, releases, containsCommit) {
  const eligible = releases.filter((release) => !change.mergedAt || Date.parse(release.publishedAt) >= Date.parse(change.mergedAt));
  const landedCommit = change.mergeCommit ?? change.headCommit;
  let release = null;
  for (const candidate of eligible) {
    if (await containsCommit(landedCommit, candidate.commit)) {
      release = candidate;
      break;
    }
  }
  if (!release) return structuredClone(change);
  if (change.releasedAt && change.releasedAt !== release.publishedAt) {
    throw new Error(`Conflicting GitHub release timestamp for delivery change ${change.id}.`);
  }
  return { ...change, releasedAt: release.publishedAt, releaseCommit: release.commit };
}

function sameCommit(ancestor, descendant) {
  return ancestor === descendant;
}

function sameRepository(left, right) {
  return typeof left === "string" && left.toLowerCase() === String(right ?? "").toLowerCase();
}

function laterTimestamp(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
