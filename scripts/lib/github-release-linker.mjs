import { validateGitHubReleaseSnapshot } from "./github-release-collector.mjs";
import { validateProviderSnapshot } from "./portable-evidence.mjs";

export async function linkGitHubReleases({
  providerSnapshot,
  releaseSnapshot,
  containsCommit = sameCommit,
}) {
  validateGitHubReleaseSnapshot(releaseSnapshot);
  assertValidProviderSnapshot(providerSnapshot);
  assertLinkableSnapshots(providerSnapshot, releaseSnapshot);
  if (typeof containsCommit !== "function") {
    throw new Error("Release linking requires a commit-containment resolver.");
  }

  const releases = releaseSnapshot.releases
    .filter((release) => release.commitStatus === "resolved")
    .toSorted(compareReleases);
  const linked = structuredClone(providerSnapshot);
  linked.capturedAt = laterTimestamp(
    providerSnapshot.capturedAt,
    releaseSnapshot.capturedAt,
  );
  linked.sources.github.version = newerSourceVersion(
    providerSnapshot.sources.github.version,
    releaseSnapshot.capturedAt,
  );
  linked.deliveryChanges = await Promise.all(
    providerSnapshot.deliveryChanges.map((change) =>
      linkChange(change, releases, containsCommit)
    ),
  );
  assertValidProviderSnapshot(linked);
  return linked;
}

function assertLinkableSnapshots(providerSnapshot, releaseSnapshot) {
  if (releaseSnapshot.status !== "available") {
    throw new Error("Cannot link a blocked GitHub release snapshot.");
  }
  if (!sameRepository(providerSnapshot.repository, releaseSnapshot.repository)) {
    throw new Error("Provider and GitHub release snapshots must name the same repository.");
  }
  if (providerSnapshot.sources.github.status !== "available") {
    throw new Error("Provider snapshot requires available GitHub evidence.");
  }
}

async function linkChange(change, releases, containsCommit) {
  if (!hasLandedCommit(change)) return structuredClone(change);
  const eligible = releases.filter(publishedAfterMerge.bind(null, change.mergedAt));
  const matched = await firstContainingRelease(
    change.mergeCommit,
    eligible,
    containsCommit,
  );
  if (!matched) return structuredClone(change);
  assertCompatibleReleaseClaim(change, matched);
  return {
    ...change,
    releasedAt: matched.publishedAt,
    releaseCommit: matched.commit,
  };
}

function hasLandedCommit(change) {
  return change.mergedAt !== null
    && change.mergeCommit !== undefined
    && change.mergeCommit !== null;
}

function publishedAfterMerge(mergedAt, release) {
  return Date.parse(release.publishedAt) >= Date.parse(mergedAt);
}

async function firstContainingRelease(landedCommit, releases, containsCommit) {
  for (const release of releases) {
    if (await containsCommit(landedCommit, release.commit)) return release;
  }
  return null;
}

function assertCompatibleReleaseClaim(change, release) {
  assertCompatibleClaim(
    change.releasedAt,
    release.publishedAt,
    `Conflicting GitHub release timestamp for delivery change ${change.id}.`,
  );
  assertCompatibleClaim(
    change.releaseCommit,
    release.commit,
    `Conflicting GitHub release commit for delivery change ${change.id}.`,
  );
}

function assertCompatibleClaim(existing, observed, message) {
  if (existing !== undefined && existing !== null && existing !== observed) {
    throw new Error(message);
  }
}

function assertValidProviderSnapshot(snapshot) {
  const candidate = Object(snapshot);
  const errors = validateProviderSnapshot(snapshot, providerValidationContext(candidate));
  if (errors.length > 0) {
    throw new Error(`Invalid provider snapshot: ${errors.join("; ")}`);
  }
}

function providerValidationContext(snapshot) {
  return {
    repository: snapshot.repository,
    headCommit: snapshot.headCommit,
    observedAt: snapshot.capturedAt,
  };
}
function compareReleases(left, right) {
  return Date.parse(left.publishedAt) - Date.parse(right.publishedAt)
    || left.id.localeCompare(right.id);
}

function sameCommit(ancestor, descendant) {
  return ancestor === descendant;
}

function sameRepository(left, right) {
  return typeof left === "string"
    && left.toLowerCase() === String(right ?? "").toLowerCase();
}

function laterTimestamp(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function newerSourceVersion(existing, releaseCapturedAt) {
  const existingTimestamp = Date.parse(existing);
  if (!Number.isFinite(existingTimestamp)) return existing;
  return existingTimestamp >= Date.parse(releaseCapturedAt)
    ? existing
    : releaseCapturedAt;
}
