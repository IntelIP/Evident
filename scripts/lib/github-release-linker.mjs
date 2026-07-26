import { validateGitHubReleaseSnapshot } from "./github-release-collector.mjs";
import { validateProviderSnapshot } from "./analytics.mjs";

export function linkGitHubReleases({ providerSnapshot, releaseSnapshot }) {
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
  const releasesByCommit = new Map();
  for (const release of releaseSnapshot.releases) {
    if (release.commitStatus !== "resolved") continue;
    const existing = releasesByCommit.get(release.commit);
    if (!existing || Date.parse(release.publishedAt) < Date.parse(existing.publishedAt)) {
      releasesByCommit.set(release.commit, release);
    }
  }
  const linked = structuredClone(providerSnapshot);
  linked.capturedAt = laterTimestamp(providerSnapshot.capturedAt, releaseSnapshot.capturedAt);
  linked.sources.github.version = laterTimestamp(providerSnapshot.sources.github.version, releaseSnapshot.capturedAt);
  linked.deliveryChanges = providerSnapshot.deliveryChanges.map((change) => linkChange(change, releasesByCommit));
  return linked;
}

function linkChange(change, releasesByCommit) {
  const release = releasesByCommit.get(change?.headCommit);
  if (!release || (change.mergedAt && Date.parse(release.publishedAt) < Date.parse(change.mergedAt))) return structuredClone(change);
  if (change.releasedAt && change.releasedAt !== release.publishedAt) {
    throw new Error(`Conflicting GitHub release timestamp for delivery change ${change.id}.`);
  }
  return { ...change, releasedAt: release.publishedAt };
}

function sameRepository(left, right) {
  return typeof left === "string" && left.toLowerCase() === String(right ?? "").toLowerCase();
}

function laterTimestamp(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
