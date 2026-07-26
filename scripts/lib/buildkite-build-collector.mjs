import { readFileSync } from "node:fs";
import { parseGitHubRepositoryRemote } from "./github-repository.mjs";
import { isJsonDateTime, validateJsonSchema } from "./json-schema-validator.mjs";
const VERSION = "tabellio-buildkite-build-snapshot/v0.1";
const SCHEMA = JSON.parse(readFileSync(new URL("../../schemas/buildkite-build-snapshot.v0.1.schema.json", import.meta.url), "utf8"));
const SLUG = /^[A-Za-z0-9][-A-Za-z0-9_]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OBSERVATION_DAYS = 30;
const PAGE_SIZE = 100;
const MAX_BUILDS = 500;
const DETAIL_CONCURRENCY = 4;
export async function collectBuildkiteBuildSnapshot({ repository, organization, pipeline, capturedAt, request }) {
  if (!REPOSITORY.test(repository ?? "") || !SLUG.test(organization ?? "") || !SLUG.test(pipeline ?? "") || !isJsonDateTime(capturedAt) || typeof request !== "function") throw new Error("Buildkite collector requires repository, organization, pipeline, capturedAt, and request.");
  try {
    const pipelineRecord = await request(`/v2/organizations/${organization}/pipelines/${pipeline}`);
    assertPipelineRepository(pipelineRecord, repository);
    const horizonStart = new Date(Date.parse(capturedAt) - OBSERVATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const path = `/v2/organizations/${organization}/pipelines/${pipeline}/builds?exclude_jobs=true&exclude_pipeline=true&per_page=${PAGE_SIZE}&created_from=${encodeURIComponent(horizonStart)}&created_to=${encodeURIComponent(capturedAt)}`;
    const raw = await collectBuildPages({ path, request });
    const observed = raw.filter((build) => Date.parse(normalizeBuild(build).createdAt) >= Date.parse(horizonStart));
    const builds = await boundedMap(observed, DETAIL_CONCURRENCY, (build) => collectBuildDetails({ build, organization, pipeline, request }));
    builds.sort((a, b) => b.number - a.number);
    return validateBuildkiteBuildSnapshot({ schemaVersion: VERSION, repository, organization, pipeline, capturedAt, status: "available", reason: null, builds });
  } catch {
    return validateBuildkiteBuildSnapshot({ schemaVersion: VERSION, repository, organization, pipeline, capturedAt, status: "blocked", reason: "Buildkite build collection unavailable.", builds: [] });
  }
}
async function collectBuildPages({ path, request }) {
  const builds = [];
  for (let pageNumber = 1; pageNumber <= MAX_BUILDS / PAGE_SIZE; pageNumber += 1) {
    const response = await request(pageNumber === 1 ? path : `${path}&page=${pageNumber}`);
    const page = Array.isArray(response) ? response : response?.items;
    if (!Array.isArray(page)) throw new Error("Unexpected Buildkite build response.");
    builds.push(...page);
    if (page.length < PAGE_SIZE) return builds;
  }
  throw new Error("Buildkite observation horizon exceeds the bounded collection limit.");
}
async function boundedMap(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}
async function collectBuildDetails({ build, organization, pipeline, request }) {
  const normalized = normalizeBuild(build);
  const prefix = `/v2/organizations/${organization}/pipelines/${pipeline}/builds/${normalized.number}`;
  const jobs = await collectJobDetails(`${prefix}/jobs?per_page=100`, request);
  const artifacts = await request(`${prefix}/artifacts?per_page=100`);
  if (!Array.isArray(artifacts) || artifacts.length >= 100) throw new Error("Buildkite artifact details are unavailable or potentially truncated.");
  return { ...normalized, jobCount: jobs.length, artifactCount: artifacts.length };
}
async function collectJobDetails(path, request) {
  const items = [];
  let next = path;
  while (next) {
    const response = await request(next);
    const { page, nextPath } = normalizeJobPage(response);
    items.push(...page);
    if (items.length > 1000) throw new Error("Buildkite job detail limit exceeded.");
    next = nextPath;
  }
  return items;
}
function normalizeJobPage(response) {
  if (Array.isArray(response)) {
    if (response.length >= 100) throw new Error("Buildkite job details may be truncated.");
    return { page: response, nextPath: null };
  }
  if (!Array.isArray(response?.items)) throw new Error("Unexpected Buildkite job response.");
  const nextPath = response.links?.next ?? null;
  if (nextPath !== null && typeof nextPath !== "string") throw new Error("Unexpected Buildkite job pagination.");
  return { page: response.items, nextPath };
}
export function validateBuildkiteBuildSnapshot(snapshot) {
  const errors = validateJsonSchema(snapshot, SCHEMA);
  if (errors.length) throw new Error(`Invalid Buildkite build snapshot: ${errors.join("; ")}`);
  if ((snapshot.status === "available") !== (snapshot.reason === null)) throw new Error("Buildkite snapshot status and reason conflict.");
  if (snapshot.status === "blocked" && snapshot.builds.length) throw new Error("Blocked Buildkite snapshot cannot contain builds.");
  const buildNumbers = new Set(snapshot.builds.map((build) => build.number));
  if (buildNumbers.size !== snapshot.builds.length) throw new Error("Buildkite snapshot build numbers must be unique.");
  for (const build of snapshot.builds) {
    if (Date.parse(build.createdAt) > Date.parse(snapshot.capturedAt) || (build.finishedAt && (Date.parse(build.finishedAt) < Date.parse(build.createdAt) || Date.parse(build.finishedAt) > Date.parse(snapshot.capturedAt)))) {
      throw new Error("Buildkite build timestamps must satisfy createdAt <= finishedAt <= capturedAt.");
    }
  }
  return snapshot;
}
function assertPipelineRepository(pipelineRecord, expectedRepository) {
  const actual = parseGitHubRepositoryRemote(pipelineRecord?.repository);
  if (!actual || actual.fullName.toLowerCase() !== expectedRepository.toLowerCase()) {
    throw new Error("Buildkite pipeline repository mismatch.");
  }
}
function normalizeBuild(build) {
  const result = { number: build?.number, commit: build?.commit, state: build?.state, createdAt: build?.created_at, finishedAt: build?.finished_at ?? null };
  if (!Number.isInteger(result.number) || result.number < 1 || !OID.test(result.commit ?? "") || !/^[a-z_]{1,32}$/.test(result.state ?? "") || !isJsonDateTime(result.createdAt) || !isNullableDate(result.finishedAt)) throw new Error("Unsafe Buildkite build response.");
  return result;
}
function isNullableDate(value) { return value === null || isJsonDateTime(value); }
