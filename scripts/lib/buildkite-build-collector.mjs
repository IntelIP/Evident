import { contract } from "./contract-checks.mjs";
import { parseGitHubRepositoryRemote } from "./github-repository.mjs";
import { isSafeProviderText } from "./portable-evidence.mjs";

const VERSION = "tabellio-buildkite-build-snapshot/v0.1";
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,126}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BUILD_STATES = new Set([
  "blocked",
  "canceled",
  "canceling",
  "creating",
  "failed",
  "failing",
  "not_run",
  "passed",
  "running",
  "scheduled",
  "skipped",
  "waiting",
  "waiting_failed",
]);
const UNFINISHED_BUILD_STATES = new Set([
  "blocked",
  "canceling",
  "creating",
  "failing",
  "running",
  "scheduled",
  "waiting",
  "waiting_failed",
]);
const OBSERVATION_DAYS = 30;
const PAGE_SIZE = 100;
const MAX_BUILDS = 500;
const MAX_JOBS = 5000;
const MAX_ARTIFACTS = 5000;
const DETAIL_CONCURRENCY = 4;

export async function collectBuildkiteBuildSnapshot({
  repository,
  organization,
  pipeline,
  request,
  clock = () => new Date().toISOString(),
}) {
  assertCollectorOptions({ repository, organization, pipeline, request, clock });
  const collectionStartedAt = clock();
  assertDateTime(collectionStartedAt, "Buildkite collection start time");
  try {
    const pipelineRecord = responseBody(
      await request(`/v2/organizations/${organization}/pipelines/${pipeline}`),
    );
    const derivedRepository = pipelineRepository(pipelineRecord);
    assertExpectedRepository(derivedRepository, repository);
    assertPipelineSlug(pipelineRecord, pipeline);
    const rawBuilds = await collectBuildPages({
      organization,
      pipeline,
      through: collectionStartedAt,
      request,
    });
    const builds = await boundedMap(
      rawBuilds,
      DETAIL_CONCURRENCY,
      (build) => collectBuildDetails({ build, organization, pipeline, request }),
    );
    const capturedAt = clock();
    assertDateTime(capturedAt, "Buildkite capture time");
    assertCaptureOrdering(collectionStartedAt, capturedAt);
    builds.sort((left, right) => right.number - left.number);
    return validateBuildkiteBuildSnapshot({
      schemaVersion: VERSION,
      repository: derivedRepository,
      organization,
      pipeline,
      capturedAt,
      status: "available",
      reason: null,
      builds,
    });
  } catch {
    return blockedSnapshot({ repository, organization, pipeline, capturedAt: safeClock(clock) });
  }
}

async function collectBuildPages({ organization, pipeline, through, request }) {
  const since = new Date(
    Date.parse(through) - OBSERVATION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const prefix = `/v2/organizations/${organization}/pipelines/${pipeline}/builds`;
  const query = [
    "exclude_jobs=true",
    "exclude_pipeline=true",
    `per_page=${PAGE_SIZE}`,
    `created_from=${encodeURIComponent(since)}`,
    `created_to=${encodeURIComponent(through)}`,
  ].join("&");
  const builds = await collectPages({
    path: `${prefix}?${query}`,
    request,
    maximum: MAX_BUILDS,
    label: "Buildkite build inventory",
  });
  const normalized = builds.map(normalizeBuild);
  normalized.forEach((build) => assertBuildCreatedInWindow(build, since, through));
  return normalized;
}

async function collectBuildDetails({ build, organization, pipeline, request }) {
  const prefix = `/v2/organizations/${organization}/pipelines/${pipeline}/builds/${build.number}`;
  const detail = responseBody(await request(`${prefix}?exclude_pipeline=true`));
  const normalized = normalizeBuild(detail);
  assertSameBuild(build, normalized);
  assertEmbeddedJobs(detail.jobs);
  const [jobs, artifacts] = await Promise.all([
    collectCursorPages({
      path: `${prefix}/jobs?include_retried_jobs=true&per_page=${PAGE_SIZE}`,
      request,
      maximum: MAX_JOBS,
      label: "Buildkite job inventory",
    }),
    collectPages({
      path: `${prefix}/artifacts?per_page=${PAGE_SIZE}`,
      request,
      maximum: MAX_ARTIFACTS,
      label: "Buildkite artifact inventory",
    }),
  ]);
  assertEmbeddedJobsRepresented(detail.jobs, jobs);
  assertUniqueProviderIds(jobs, "Buildkite jobs");
  assertUniqueProviderIds(artifacts, "Buildkite artifacts");
  return {
    ...normalized,
    jobCount: jobs.length,
    artifactCount: artifacts.length,
  };
}

async function collectCursorPages({ path, request, maximum, label }) {
  const values = [];
  const maximumPages = Math.ceil(maximum / PAGE_SIZE);
  const visited = new Set();
  let next = path;
  for (let page = 1; page <= maximumPages + 1; page += 1) {
    ensure(!visited.has(next), `${label} pagination contains a cycle.`);
    visited.add(next);
    const body = responseBody(await request(next));
    contract.object(body, `${label} response`);
    ensure(Array.isArray(body.items), `${label} response is invalid.`);
    contract.object(body.links, `${label} pagination links`);
    values.push(...body.items);
    ensure(values.length <= maximum, `${label} exceeds its bounded limit.`);
    next = cursorPageNext(body, label);
    if (next === null) return values;
  }
  throw new Error(`${label} pagination exceeds its bounded limit.`);
}

function cursorPageNext(body, label) {
  if (Object.hasOwn(body.links, "next")) {
    return cursorNextPath(body.links.next, label);
  }
  ensure(
    body.items.length < PAGE_SIZE,
    `${label} pagination links are incomplete.`,
  );
  return null;
}

async function collectPages({ path, request, maximum, label }) {
  const values = [];
  const maximumPages = Math.ceil(maximum / PAGE_SIZE);
  for (let page = 1; page <= maximumPages + 1; page += 1) {
    const response = await request(withPage(path, page));
    const body = responseBody(response);
    ensure(Array.isArray(body), `${label} response is invalid.`);
    values.push(...body);
    ensure(values.length <= maximum, `${label} exceeds its bounded limit.`);
    if (!hasNextPage(response, body)) return values;
  }
  throw new Error(`${label} pagination exceeds its bounded limit.`);
}

function cursorNextPath(value, label) {
  if (value === null || value === undefined) return null;
  ensure(typeof value === "string", `${label} pagination target is invalid.`);
  const url = new URL(value, "https://api.buildkite.com");
  ensure(url.origin === "https://api.buildkite.com", `${label} pagination target is invalid.`);
  ensure(url.username === "" && url.password === "", `${label} pagination target is invalid.`);
  ensure(url.pathname.startsWith("/v2/"), `${label} pagination target is invalid.`);
  ensure(url.hash === "", `${label} pagination target is invalid.`);
  return `${url.pathname}${url.search}`;
}

function responseBody(response) {
  return isResponseEnvelope(response) ? response.body : response;
}

function hasNextPage(response, body) {
  if (isResponseEnvelope(response)) return response.nextPage === true;
  return body.length === PAGE_SIZE;
}

function isResponseEnvelope(value) {
  try {
    contract.object(value, "Buildkite response envelope");
    contract.exactKeys(value, ["body", "nextPage"], "Buildkite response envelope");
    contract.member(value.nextPage, [true, false], "Buildkite response nextPage");
    return true;
  } catch {
    return false;
  }
}

function withPage(path, page) {
  return `${path}${path.includes("?") ? "&" : "?"}page=${page}`;
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
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return results;
}

export function validateBuildkiteBuildSnapshot(snapshot) {
  contract.object(snapshot, "Buildkite snapshot");
  contract.exactKeys(snapshot, [
    "schemaVersion",
    "repository",
    "organization",
    "pipeline",
    "capturedAt",
    "status",
    "reason",
    "builds",
  ], "Buildkite snapshot");
  contract.equals(snapshot.schemaVersion, VERSION, "Buildkite snapshot schemaVersion");
  ensure(REPOSITORY.test(snapshot.repository ?? ""), "Buildkite snapshot repository is invalid.");
  assertSlug(snapshot.organization, 64, "Buildkite snapshot organization");
  assertSlug(snapshot.pipeline, 128, "Buildkite snapshot pipeline");
  assertDateTime(snapshot.capturedAt, "Buildkite snapshot capture time");
  contract.member(snapshot.status, ["available", "blocked"], "Buildkite snapshot status");
  ensure(Array.isArray(snapshot.builds), "Buildkite snapshot builds are invalid.");
  ensure(snapshot.builds.length <= MAX_BUILDS, "Buildkite snapshot builds are invalid.");
  assertStatusShape(snapshot);
  snapshot.builds.forEach(assertNormalizedBuild);
  assertUniqueBuildNumbers(snapshot.builds);
  snapshot.builds.forEach((build) => assertBuildTimes(build, snapshot.capturedAt));
  return snapshot;
}

function assertNormalizedBuild(build, index) {
  contract.object(build, `Buildkite build ${index}`);
  contract.exactKeys(build, [
    "number",
    "commit",
    "state",
    "createdAt",
    "finishedAt",
    "jobCount",
    "artifactCount",
  ], `Buildkite build ${index}`);
  contract.positiveInteger(build.number, `Buildkite build ${index} number`);
  ensure(OID.test(build.commit ?? ""), "Buildkite normalized build identity is invalid.");
  ensure(BUILD_STATES.has(build.state), "Buildkite normalized build identity is invalid.");
  assertDateTime(build.createdAt, `Buildkite build ${index} creation time`);
  if (build.finishedAt !== null) {
    assertDateTime(build.finishedAt, `Buildkite build ${index} completion time`);
  } else {
    ensure(
      UNFINISHED_BUILD_STATES.has(build.state),
      "Buildkite terminal build requires a completion time.",
    );
  }
  assertBoundedCount(build.jobCount, MAX_JOBS, `Buildkite build ${index} jobCount`);
  assertBoundedCount(
    build.artifactCount,
    MAX_ARTIFACTS,
    `Buildkite build ${index} artifactCount`,
  );
}

function assertCollectorOptions({ repository, organization, pipeline, request, clock }) {
  ensure(REPOSITORY.test(repository ?? ""), "Buildkite repository is invalid.");
  assertSlug(organization, 64, "Buildkite organization slug");
  assertSlug(pipeline, 128, "Buildkite pipeline slug");
  ensure(typeof request === "function", "Buildkite collector requires a request function.");
  ensure(typeof clock === "function", "Buildkite collector requires a clock function.");
}

function pipelineRepository(record) {
  const parsed = parseGitHubRepositoryRemote(record?.repository);
  if (parsed === null) throw new Error("Buildkite pipeline repository is invalid.");
  return parsed.fullName;
}

function assertExpectedRepository(actual, expected) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("Buildkite pipeline repository mismatch.");
  }
}

function assertPipelineSlug(record, expected) {
  if (record?.slug !== undefined && record.slug !== expected) {
    throw new Error("Buildkite pipeline slug mismatch.");
  }
}

function normalizeBuild(build) {
  contract.object(build, "Buildkite build response");
  const result = {
    number: build.number,
    commit: build.commit,
    state: build.state,
    createdAt: build.created_at,
    finishedAt: nullableFinishedAt(build.finished_at),
  };
  ensure(Number.isInteger(result.number), "Buildkite build number is invalid.");
  ensure(result.number >= 1, "Buildkite build number is invalid.");
  ensure(OID.test(String(result.commit)), "Buildkite build identity is invalid.");
  ensure(BUILD_STATES.has(result.state), "Buildkite build identity is invalid.");
  assertDateTime(result.createdAt, "Buildkite build creation time");
  if (result.finishedAt !== null) {
    assertDateTime(result.finishedAt, "Buildkite build completion time");
  }
  return result;
}

function nullableFinishedAt(value) {
  return value === undefined || value === null ? null : value;
}

function assertSameBuild(summary, detail) {
  if (summary.number !== detail.number || summary.commit !== detail.commit) {
    throw new Error("Buildkite build detail identity mismatch.");
  }
}

function assertEmbeddedJobs(jobs) {
  if (!Array.isArray(jobs)) throw new Error("Buildkite build response lacks jobs.");
  if (jobs.length > MAX_JOBS) throw new Error("Buildkite embedded jobs exceed their bounded limit.");
}

function assertEmbeddedJobsRepresented(embedded, paged) {
  const ids = new Set(paged.map((job) => requiredProviderId(job?.id, "Buildkite job")));
  for (const job of embedded) {
    if (!ids.has(requiredProviderId(job?.id, "Buildkite embedded job"))) {
      throw new Error("Buildkite paginated jobs omit an embedded job.");
    }
  }
}

function requiredProviderId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(value)) {
    throw new Error(`${label} identifier is invalid.`);
  }
  return value;
}

function assertStatusShape(snapshot) {
  if (snapshot.status === "available") return assertAvailableSnapshot(snapshot);
  ensure(snapshot.builds.length === 0, "Blocked Buildkite snapshot cannot contain builds.");
  ensure(isSafeProviderText(snapshot.reason), "Blocked Buildkite snapshot requires a safe reason.");
}

function assertAvailableSnapshot(snapshot) {
  ensure(snapshot.reason === null, "Buildkite snapshot status and reason conflict.");
}

function assertUniqueBuildNumbers(builds) {
  if (new Set(builds.map((build) => build.number)).size !== builds.length) {
    throw new Error("Buildkite snapshot build numbers must be unique.");
  }
}

function assertBuildTimes(build, capturedAt) {
  const created = Date.parse(build.createdAt);
  const captured = Date.parse(capturedAt);
  const finished = build.finishedAt === null ? null : Date.parse(build.finishedAt);
  ensure(created <= captured, "Buildkite build timestamps must satisfy createdAt <= finishedAt <= capturedAt.");
  if (finished === null) return;
  ensure(finished >= created, "Buildkite build timestamps must satisfy createdAt <= finishedAt <= capturedAt.");
  ensure(finished <= captured, "Buildkite build timestamps must satisfy createdAt <= finishedAt <= capturedAt.");
}

function assertBuildCreatedInWindow(build, since, through) {
  const created = Date.parse(build.createdAt);
  ensure(created >= Date.parse(since), "Buildkite build predates the observation horizon.");
  ensure(created <= Date.parse(through), "Buildkite build postdates the inventory query.");
}

function assertUniqueProviderIds(values, label) {
  const ids = values.map((value) => requiredProviderId(value?.id, label));
  ensure(new Set(ids).size === ids.length, `${label} contain duplicate identifiers.`);
}

function assertSlug(value, maximum, label) {
  ensure(SLUG.test(value ?? ""), `${label} is invalid.`);
  ensure(value.length <= maximum, `${label} is invalid.`);
}

function assertBoundedCount(value, maximum, label) {
  ensure(Number.isInteger(value), `${label} is invalid.`);
  ensure(value >= 0, `${label} is invalid.`);
  ensure(value <= maximum, `${label} is invalid.`);
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDateTime(value, label) {
  try {
    contract.date(value, label);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
}

function assertCaptureOrdering(startedAt, capturedAt) {
  if (Date.parse(capturedAt) < Date.parse(startedAt)) {
    throw new Error("Buildkite capture predates collection.");
  }
}

function safeClock(clock) {
  try {
    const value = clock();
    assertDateTime(value, "Buildkite capture time");
    return value;
  } catch {
    return new Date(0).toISOString();
  }
}

function blockedSnapshot({ repository, organization, pipeline, capturedAt }) {
  return validateBuildkiteBuildSnapshot({
    schemaVersion: VERSION,
    repository,
    organization,
    pipeline,
    capturedAt,
    status: "blocked",
    reason: "Buildkite build collection unavailable.",
    builds: [],
  });
}
