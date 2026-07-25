import { readFileSync } from "node:fs";

import { isJsonDateTime, validateJsonSchema } from "./json-schema-validator.mjs";

const SCHEMA_VERSION = "tabellio-github-release-snapshot/v0.1";
const SCHEMA = JSON.parse(readFileSync(
  new URL("../../schemas/github-release-snapshot.v0.1.schema.json", import.meta.url),
  "utf8",
));
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export async function collectGitHubReleaseSnapshot({ repository, capturedAt, request }) {
  if (!REPOSITORY.test(repository ?? "")) throw new Error("GitHub release collector requires owner/repository.");
  if (!isJsonDateTime(capturedAt)) throw new Error("GitHub release collector requires capturedAt.");
  if (typeof request !== "function") throw new Error("GitHub release collector requires a request function.");
  try {
    const payload = await collectAll(`/repos/${repository}/releases?per_page=100`, request);
    const releases = await Promise.all(payload
      .filter((release) => release?.draft !== true && isPublishedRelease(release) && Date.parse(release.published_at) <= Date.parse(capturedAt))
      .map(async (release) => normalizeRelease({ repository, release, request })));
    const snapshot = { schemaVersion: SCHEMA_VERSION, repository, capturedAt, status: "available", reason: null, releases };
    return validateGitHubReleaseSnapshot(snapshot);
  } catch {
    return validateGitHubReleaseSnapshot({
      schemaVersion: SCHEMA_VERSION,
      repository,
      capturedAt,
      status: "blocked",
      reason: "GitHub release collection unavailable.",
      releases: [],
    });
  }
}
async function collectAll(path, request) { const all=[]; for(let pageNumber=1;;pageNumber+=1){const separator=path.includes("?")?"&":"?";const target=pageNumber===1?path:`${path}${separator}page=${pageNumber}`;const page=await request(target); if(!Array.isArray(page)) throw new Error("Unexpected releases response."); all.push(...page); if(page.length<100) return all;} }

export function validateGitHubReleaseSnapshot(snapshot) {
  const errors = validateJsonSchema(snapshot, SCHEMA);
  if (errors.length > 0) throw new Error(`Invalid GitHub release snapshot: ${errors.join("; ")}`);
  if (snapshot.status === "available" && snapshot.reason !== null) throw new Error("Available GitHub release snapshot cannot have a reason.");
  if (snapshot.status === "blocked" && (!snapshot.reason || snapshot.releases.length !== 0)) {
    throw new Error("Blocked GitHub release snapshot requires a reason and no releases.");
  }
  for (const release of snapshot.releases) assertReleaseEvidence(release, snapshot.capturedAt);
  return snapshot;
}

function assertReleaseEvidence(release, capturedAt) {
  assertCommitEvidence(release);
  if (Date.parse(release.publishedAt) > Date.parse(capturedAt)) throw new Error("Release publishedAt cannot be newer than capturedAt.");
}

function assertCommitEvidence(release) {
  if (release.commitStatus === "resolved" && !OID.test(release.commit ?? "")) throw new Error("Resolved release requires an exact commit.");
  if (release.commitStatus === "blocked" && release.commit !== null) throw new Error("Blocked release cannot claim an exact commit.");
}

async function normalizeRelease({ repository, release, request }) {
  const id = String(release.id ?? "");
  const tagName = String(release.tag_name ?? "");
  const publishedAt = release.published_at;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || !TAG.test(tagName) || !isJsonDateTime(publishedAt)) {
    throw new Error("Release response has unsafe fields.");
  }
  const commit = await resolveTagCommit({ repository, tagName, request });
  return { id, tagName, publishedAt, commit, commitStatus: commit ? "resolved" : "blocked" };
}

function isPublishedRelease(release) {
  return typeof release?.published_at === "string";
}

async function resolveTagCommit({ repository, tagName, request }) {
  try {
    let reference = await request(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tagName)}`);
    for (let depth = 0; depth < 4; depth += 1) {
      const object = reference?.object;
      if (object?.type === "commit" && OID.test(object.sha ?? "")) return object.sha;
      if (object?.type !== "tag" || !OID.test(object.sha ?? "")) return null;
      reference = await request(`/repos/${repository}/git/tags/${object.sha}`);
    }
  } catch {
    return null;
  }
  return null;
}
