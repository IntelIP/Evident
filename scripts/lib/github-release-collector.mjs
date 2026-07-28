import { contract } from "./contract-checks.mjs";
import { boundedMap } from "./bounded-map.mjs";
import { collectPagedApi } from "./paged-api-collector.mjs";

const VERSION = "tabellio-github-release-snapshot/v0.1";
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RELEASE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TAG = /^(?!@(?:$|\/))(?!.*(?:\.\.|@\{|\/\/))(?!.*(?:^|\/)\.)(?!.*(?:\.|\.lock)(?:\/|$))[A-Za-z0-9+_-][A-Za-z0-9._+@/-]{0,127}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_ANNOTATED_TAG_DEPTH = 8;
const PAGE_SIZE = 100;
const TAG_RESOLUTION_CONCURRENCY = 8;

export async function collectGitHubReleaseSnapshot({
  repository,
  capturedAt,
  request,
}) {
  assertCollectorOptions({ repository, capturedAt, request });
  try {
    const payload = await collectPagedApi({
      path: `/repos/${repository}/releases?per_page=${PAGE_SIZE}`,
      request,
      invalidPageMessage: "Unexpected releases response.",
    });
    const observed = payload.filter((release) =>
      release?.draft !== true && observedPublishedRelease(release, capturedAt)
    );
    const releases = await boundedMap(
      observed,
      TAG_RESOLUTION_CONCURRENCY,
      (release) => normalizeRelease({ repository, release, request }),
    );
    return validateGitHubReleaseSnapshot({
      schemaVersion: VERSION,
      repository,
      capturedAt,
      status: "available",
      reason: null,
      releases,
    });
  } catch {
    return validateGitHubReleaseSnapshot({
      schemaVersion: VERSION,
      repository,
      capturedAt,
      status: "blocked",
      reason: "GitHub release collection unavailable.",
      releases: [],
    });
  }
}

export function validateGitHubReleaseSnapshot(snapshot) {
  contract.object(snapshot, "GitHub release snapshot");
  contract.exactKeys(snapshot, [
    "schemaVersion",
    "repository",
    "capturedAt",
    "status",
    "reason",
    "releases",
  ], "GitHub release snapshot");
  contract.equals(snapshot.schemaVersion, VERSION, "GitHub release snapshot schemaVersion");
  ensure(REPOSITORY.test(snapshot.repository ?? ""), "GitHub release snapshot repository is invalid.");
  assertDateTime(snapshot.capturedAt, "GitHub release snapshot capturedAt");
  contract.member(snapshot.status, ["available", "blocked"], "GitHub release snapshot status");
  ensure(Array.isArray(snapshot.releases), "GitHub release snapshot releases are invalid.");
  assertStatusShape(snapshot);
  snapshot.releases.forEach((release, index) =>
    assertReleaseEvidence(release, index, snapshot.capturedAt)
  );
  assertUniqueReleases(snapshot.releases);
  return snapshot;
}

function assertCollectorOptions({ repository, capturedAt, request }) {
  ensure(REPOSITORY.test(repository ?? ""), "GitHub release collector requires owner/repository.");
  assertDateTime(capturedAt, "GitHub release collector capturedAt");
  ensure(typeof request === "function", "GitHub release collector requires a request function.");
}

function assertStatusShape(snapshot) {
  if (snapshot.status === "available") {
    ensure(snapshot.reason === null, "Available GitHub release snapshot cannot have a reason.");
    return;
  }
  ensure(
    typeof snapshot.reason === "string"
      && snapshot.reason.length > 0
      && snapshot.releases.length === 0,
    "Blocked GitHub release snapshot requires a reason and no releases.",
  );
}

function assertReleaseEvidence(release, index, capturedAt) {
  contract.object(release, `GitHub release ${index}`);
  contract.exactKeys(release, [
    "id",
    "tagName",
    "publishedAt",
    "commit",
    "commitStatus",
  ], `GitHub release ${index}`);
  assertReleaseIdentity(release);
  assertReleaseTime(release, capturedAt);
  assertReleaseCommit(release);
}

function assertReleaseIdentity(release) {
  ensure(RELEASE_ID.test(release.id ?? ""), "GitHub release identity is invalid.");
  ensure(TAG.test(release.tagName ?? ""), "GitHub release tag is invalid.");
}

function assertReleaseTime(release, capturedAt) {
  assertDateTime(release.publishedAt, "GitHub release publishedAt");
  ensure(
    Date.parse(release.publishedAt) <= Date.parse(capturedAt),
    "Release publishedAt cannot be newer than capturedAt.",
  );
}

function assertReleaseCommit(release) {
  contract.member(release.commitStatus, ["resolved", "blocked"], "GitHub release commitStatus");
  if (release.commitStatus === "resolved") {
    ensure(OID.test(release.commit ?? ""), "Resolved release requires an exact commit.");
  } else {
    ensure(release.commit === null, "Blocked release cannot claim an exact commit.");
  }
}

function assertUniqueReleases(releases) {
  const ids = new Set();
  const tags = new Set();
  for (const release of releases) {
    ensure(!ids.has(release.id), "GitHub release IDs and tag names must be unique.");
    ensure(!tags.has(release.tagName), "GitHub release IDs and tag names must be unique.");
    ids.add(release.id);
    tags.add(release.tagName);
  }
}

async function normalizeRelease({ repository, release, request }) {
  const id = providerString(release, "id");
  const tagName = providerString(release, "tag_name");
  const publishedAt = providerValue(release, "published_at");
  assertNormalizedReleaseFields({ id, tagName, publishedAt });
  const commit = await resolveTagCommit({ repository, tagName, request });
  return {
    id,
    tagName,
    publishedAt,
    ...commitEvidence(commit),
  };
}

function providerValue(record, field) {
  return Object(record)[field];
}

function providerString(record, field) {
  return String(providerValue(record, field) ?? "");
}

function commitEvidence(commit) {
  return commit === null
    ? { commit: null, commitStatus: "blocked" }
    : { commit, commitStatus: "resolved" };
}

function assertNormalizedReleaseFields({ id, tagName, publishedAt }) {
  ensure(RELEASE_ID.test(id), "Release response has unsafe fields.");
  ensure(TAG.test(tagName), "Release response has unsafe fields.");
  ensure(isDateTime(publishedAt), "Release response has unsafe fields.");
}

function observedPublishedRelease(release, capturedAt) {
  const publishedAt = providerValue(release, "published_at");
  if (publishedAt == null) return false;
  assertPublishedAt(publishedAt);
  return Date.parse(publishedAt) <= Date.parse(capturedAt);
}

function assertPublishedAt(value) {
  if (!isDateTime(value)) throw new Error("Published release has an invalid timestamp.");
}

async function resolveTagCommit({ repository, tagName, request }) {
  try {
    const reference = await request(
      `/repos/${repository}/git/ref/tags/${encodeURIComponent(tagName)}`,
    );
    return peelTagReference({ repository, reference, request });
  } catch {
    return null;
  }
}

async function peelTagReference({ repository, reference: initialReference, request }) {
  return peelTagObject({
    repository,
    object: Object(initialReference).object,
    request,
    depth: 0,
  });
}

async function peelTagObject({ repository, object: candidate, request, depth }) {
  if (depth >= MAX_ANNOTATED_TAG_DEPTH) return null;
  const object = validTagObject(candidate);
  if (object === null) return null;
  if (object.type === "commit") return object.sha;
  const next = await request(`/repos/${repository}/git/tags/${object.sha}`);
  return peelTagObject({
    repository,
    object: Object(next).object,
    request,
    depth: depth + 1,
  });
}

function validTagObject(object) {
  const candidate = Object(object);
  if (!OID.test(candidate.sha ?? "")) return null;
  return ["commit", "tag"].includes(candidate.type) ? candidate : null;
}

function assertDateTime(value, label) {
  ensure(isDateTime(value), `${label} is invalid.`);
}

function isDateTime(value) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
