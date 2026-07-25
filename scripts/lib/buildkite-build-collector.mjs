import { readFileSync } from "node:fs";
import { isJsonDateTime, validateJsonSchema } from "./json-schema-validator.mjs";
const VERSION = "tabellio-buildkite-build-snapshot/v0.1";
const SCHEMA = JSON.parse(readFileSync(new URL("../../schemas/buildkite-build-snapshot.v0.1.schema.json", import.meta.url), "utf8"));
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export async function collectBuildkiteBuildSnapshot({ organization, pipeline, capturedAt, request }) {
  if (!SLUG.test(organization ?? "") || !SLUG.test(pipeline ?? "") || !isJsonDateTime(capturedAt) || typeof request !== "function") throw new Error("Buildkite collector requires organization, pipeline, capturedAt, and request.");
  try {
    const raw = await request(`/v2/organizations/${organization}/pipelines/${pipeline}/builds?exclude_jobs=true&exclude_pipeline=true&per_page=100`);
    if (!Array.isArray(raw)) throw new Error("Unexpected Buildkite build response.");
    const detailRequests = [];
    for (const build of raw) detailRequests.push(collectBuildDetails({ build, organization, pipeline, request }));
    const builds = await Promise.all(detailRequests);
    builds.sort((a, b) => b.number - a.number);
    return validateBuildkiteBuildSnapshot({ schemaVersion: VERSION, organization, pipeline, capturedAt, status: "available", reason: null, builds });
  } catch {
    return validateBuildkiteBuildSnapshot({ schemaVersion: VERSION, organization, pipeline, capturedAt, status: "blocked", reason: "Buildkite build collection unavailable.", builds: [] });
  }
}
async function collectBuildDetails({ build, organization, pipeline, request }) {
  const normalized = normalizeBuild(build);
  const prefix = `/v2/organizations/${organization}/pipelines/${pipeline}/builds/${normalized.number}`;
  const [jobs, artifacts] = await Promise.all([request(`${prefix}/jobs?per_page=100`), request(`${prefix}/artifacts?per_page=100`)]);
  const jobItems = Array.isArray(jobs) ? jobs : jobs?.items;
  if (!Array.isArray(jobItems) || !Array.isArray(artifacts)) throw new Error("Unexpected Buildkite detail response.");
  return { ...normalized, jobCount: jobItems.length, artifactCount: artifacts.length };
}
export function validateBuildkiteBuildSnapshot(snapshot) {
  const errors = validateJsonSchema(snapshot, SCHEMA);
  if (errors.length) throw new Error(`Invalid Buildkite build snapshot: ${errors.join("; ")}`);
  if ((snapshot.status === "available") !== (snapshot.reason === null)) throw new Error("Buildkite snapshot status and reason conflict.");
  if (snapshot.status === "blocked" && snapshot.builds.length) throw new Error("Blocked Buildkite snapshot cannot contain builds.");
  return snapshot;
}
function normalizeBuild(build) {
  const result = { number: build?.number, commit: build?.commit, state: build?.state, createdAt: build?.created_at, finishedAt: build?.finished_at ?? null };
  if (!Number.isInteger(result.number) || result.number < 1 || !OID.test(result.commit ?? "") || !/^[a-z_]{1,32}$/.test(result.state ?? "") || !isJsonDateTime(result.createdAt) || !isNullableDate(result.finishedAt)) throw new Error("Unsafe Buildkite build response.");
  return result;
}
function isNullableDate(value) { return value === null || isJsonDateTime(value); }
