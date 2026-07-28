import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  collectBuildkiteBuildSnapshot,
  validateBuildkiteBuildSnapshot,
} from "../scripts/lib/buildkite-build-collector.mjs";

const STARTED_AT = "2026-07-25T12:00:00.000Z";
const CAPTURED_AT = "2026-07-25T12:00:01.000Z";
const COMMIT = "a".repeat(40);
const execFileAsync = promisify(execFile);

test("Buildkite collector preserves complete exact build evidence", async () => {
  const calls = [];
  const snapshot = await collectBuildkiteBuildSnapshot({
    ...collectorOptions(),
    request: fixtureRequest({ calls }),
  });
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.repository, "IntelIP/Tabellio");
  assert.equal(snapshot.capturedAt, CAPTURED_AT);
  assert.deepEqual(snapshot.builds, [{
    number: 4,
    commit: COMMIT,
    state: "passed",
    createdAt: "2026-07-25T11:00:00.000Z",
    finishedAt: "2026-07-25T11:02:00.000Z",
    jobCount: 1,
    artifactCount: 2,
  }]);
  assert.ok(calls.some((path) => path.includes("created_from=")));
  assert.ok(calls.some((path) => path.includes("created_to=")));
  assert.ok(calls.some((path) => path.includes("/builds/4/jobs?")));
  assert.ok(calls.some((path) => path.includes("/builds/4/artifacts?")));
});

test("Buildkite collector accepts valid hyphenated slugs", async () => {
  const snapshot = await collectBuildkiteBuildSnapshot({
    ...collectorOptions(),
    organization: "intelip-platform",
    pipeline: "product-validation",
    request: fixtureRequest({
      organization: "intelip-platform",
      pipeline: "product-validation",
    }),
  });
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.organization, "intelip-platform");
  assert.equal(snapshot.pipeline, "product-validation");
});

test("Buildkite collector rejects unsafe slugs before provider access", async () => {
  let called = false;
  await assert.rejects(
    collectBuildkiteBuildSnapshot({
      ...collectorOptions(),
      pipeline: "../private",
      request: async () => {
        called = true;
      },
    }),
    /pipeline slug is invalid/,
  );
  assert.equal(called, false);
});

test("Buildkite collector derives and verifies pipeline repository identity", async () => {
  const snapshot = await collectBuildkiteBuildSnapshot({
    ...collectorOptions(),
    request: fixtureRequest({ repository: "IntelIP/Other" }),
  });
  assert.equal(snapshot.status, "blocked");
  assert.equal(snapshot.repository, "IntelIP/Tabellio");
});

test("Buildkite collector blocks mismatched pipeline response slug", async () => {
  const snapshot = await collectBuildkiteBuildSnapshot({
    ...collectorOptions(),
    request: fixtureRequest({ responsePipeline: "other-pipeline" }),
  });
  assert.equal(snapshot.status, "blocked");
});

test("Buildkite collector paginates builds, jobs, and artifacts", async () => {
  const calls = [];
  const builds = Array.from({ length: 101 }, (_, index) => build(index + 1));
  const jobs = Array.from({ length: 101 }, (_, index) => ({ id: `job-${index + 1}` }));
  const artifacts = Array.from(
    { length: 101 },
    (_, index) => ({ id: `artifact-${index + 1}` }),
  );
  const snapshot = await collectBuildkiteBuildSnapshot({
    ...collectorOptions(),
    request: fixtureRequest({ builds, jobs, artifacts, calls }),
  });
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.builds.length, 101);
  assert.equal(snapshot.builds[0].number, 101);
  assert.equal(snapshot.builds[0].jobCount, 101);
  assert.equal(snapshot.builds[0].artifactCount, 101);
  assert.ok(calls.some((path) => path.includes("/jobs?") && path.includes("cursor=100")));
});

test("Buildkite collector preserves unfinished and waiting builds", async () => {
  for (const state of ["waiting", "waiting_failed", "running"]) {
    const snapshot = await collectBuildkiteBuildSnapshot({
      ...collectorOptions(),
      request: fixtureRequest({
        builds: [{ ...build(4), state, finished_at: null }],
      }),
    });
    assert.equal(snapshot.status, "available");
    assert.equal(snapshot.builds[0].state, state);
    assert.equal(snapshot.builds[0].finishedAt, null);
  }
});

test("Buildkite collector rejects unfinished terminal builds", async () => {
  for (const state of ["passed", "failed", "canceled", "not_run", "skipped"]) {
    const snapshot = await collectBuildkiteBuildSnapshot({
      ...collectorOptions(),
      request: fixtureRequest({
        builds: [{ ...build(4), state, finished_at: null }],
      }),
    });
    assert.equal(snapshot.status, "blocked");
  }
});

test("Buildkite collector rejects incomplete cursor metadata", async () => {
  for (const jobLinks of ["missing", {}, { next: 7 }]) {
    const snapshot = await collectBuildkiteBuildSnapshot({
      ...collectorOptions(),
      request: fixtureRequest({
        jobs: Array.from({ length: 100 }, (_, index) => ({ id: `job-${index}` })),
        jobLinks,
      }),
    });
    assert.equal(snapshot.status, "blocked");
  }
});

test("Buildkite collector accepts omitted next on a short final cursor page", async () => {
  const snapshot = await collectBuildkiteBuildSnapshot({
    ...collectorOptions(),
    request: fixtureRequest({
      jobs: [{ id: "job-1" }],
      jobLinks: {},
    }),
  });
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.builds[0].jobCount, 1);
});

test("Buildkite collector rejects build pagination beyond its bound", async () => {
  const builds = Array.from({ length: 501 }, (_, index) => build(index + 1));
  const snapshot = await collectBuildkiteBuildSnapshot({
    ...collectorOptions(),
    request: fixtureRequest({ builds }),
  });
  assert.equal(snapshot.status, "blocked");
});

test("Buildkite collector rejects job pagination beyond its bound", async () => {
  const jobs = Array.from({ length: 5001 }, (_, index) => ({ id: `job-${index + 1}` }));
  const snapshot = await collectBuildkiteBuildSnapshot({
    ...collectorOptions(),
    request: fixtureRequest({ jobs }),
  });
  assert.equal(snapshot.status, "blocked");
});

test("Buildkite collector rejects duplicate job and artifact identifiers", async () => {
  for (const providerValues of [
    { jobs: [{ id: "job-1" }, { id: "job-1" }] },
    { artifacts: [{ id: "artifact-1" }, { id: "artifact-1" }] },
  ]) {
    const snapshot = await collectBuildkiteBuildSnapshot({
      ...collectorOptions(),
      request: fixtureRequest(providerValues),
    });
    assert.equal(snapshot.status, "blocked");
  }
});

test("Buildkite collector requires jobs in the detailed build response", async () => {
  const snapshot = await collectBuildkiteBuildSnapshot({
    ...collectorOptions(),
    request: fixtureRequest({ omitEmbeddedJobs: true }),
  });
  assert.equal(snapshot.status, "blocked");
});

test("Buildkite collector rejects disagreement between embedded and paged jobs", async () => {
  const snapshot = await collectBuildkiteBuildSnapshot({
    ...collectorOptions(),
    request: fixtureRequest({
      jobs: [{ id: "another-job" }],
      embeddedJobs: [{ id: "job-1" }],
    }),
  });
  assert.equal(snapshot.status, "blocked");
});

test("Buildkite collector bounds concurrent detail requests", async () => {
  let active = 0;
  let maximum = 0;
  const builds = Array.from({ length: 12 }, (_, index) => build(index + 1));
  const baseRequest = fixtureRequest({ builds });
  const snapshot = await collectBuildkiteBuildSnapshot({
    ...collectorOptions(),
    request: async (path) => {
      if (!/\/builds\/\d+\?exclude_pipeline=true/.test(path)) return baseRequest(path);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const response = await baseRequest(path);
      active -= 1;
      return response;
    },
  });
  assert.equal(snapshot.status, "available");
  assert.ok(maximum <= 4);
  console.log(`buildkite_detail_max_concurrency=${maximum}`);
});

test("Buildkite collector captures observation after provider collection", async () => {
  const events = [];
  const request = fixtureRequest();
  const snapshot = await collectBuildkiteBuildSnapshot({
    ...collectorOptions(),
    clock: () => {
      events.push("clock");
      return events.length === 1 ? STARTED_AT : CAPTURED_AT;
    },
    request: async (path) => {
      events.push(path);
      return request(path);
    },
  });
  assert.equal(snapshot.status, "available");
  assert.equal(events.at(-1), "clock");
  assert.equal(snapshot.capturedAt, CAPTURED_AT);
});

test("Buildkite collector blocks safely without provider error leakage", async () => {
  const snapshot = await collectBuildkiteBuildSnapshot({
    ...collectorOptions(),
    request: async () => {
      throw new Error("authorization=private-token /Users/private/response.json");
    },
  });
  assert.equal(snapshot.status, "blocked");
  assert.equal(snapshot.reason, "Buildkite build collection unavailable.");
  assert.doesNotMatch(JSON.stringify(snapshot), /private-token|Users\/private/);
});

test("Buildkite snapshot rejects duplicate build numbers", () => {
  const snapshot = availableSnapshot();
  assert.throws(
    () => validateBuildkiteBuildSnapshot({
      ...snapshot,
      builds: [snapshot.builds[0], snapshot.builds[0]],
    }),
    /build numbers must be unique/,
  );
});

test("Buildkite snapshot rejects events outside capture ordering", () => {
  const snapshot = availableSnapshot();
  for (const change of [
    { createdAt: "2026-07-25T12:00:02.000Z" },
    { finishedAt: "2026-07-25T10:59:59.000Z" },
    { finishedAt: "2026-07-25T12:00:02.000Z" },
  ]) {
    assert.throws(
      () => validateBuildkiteBuildSnapshot({
        ...snapshot,
        builds: [{ ...snapshot.builds[0], ...change }],
      }),
      /createdAt <= finishedAt <= capturedAt/,
    );
  }
});

test("Buildkite collector rejects builds outside the requested observation window", async () => {
  for (const createdAt of [
    "2026-06-24T11:00:00.000Z",
    "2026-07-25T12:00:01.000Z",
  ]) {
    const values = [{ ...build(4), created_at: createdAt }];
    const snapshot = await collectBuildkiteBuildSnapshot({
      ...collectorOptions(),
      request: fixtureRequest({ builds: values }),
    });
    assert.equal(snapshot.status, "blocked");
  }
});

test("Buildkite snapshot contract rejects extra fields and unsafe blocked reasons", () => {
  const snapshot = availableSnapshot();
  assert.throws(
    () => validateBuildkiteBuildSnapshot({ ...snapshot, extra: true }),
    /must contain exactly/,
  );
  assert.throws(
    () => validateBuildkiteBuildSnapshot({
      ...snapshot,
      status: "blocked",
      reason: "token=private /Users/private",
      builds: [],
    }),
    /safe reason/,
  );
});

test("Buildkite snapshot schema couples availability to reason and builds", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schemas/buildkite-build-snapshot.v0.1.schema.json", import.meta.url),
    "utf8",
  ));
  const statusRule = schema.allOf.find(
    (rule) => rule.if?.properties?.status?.const === "available",
  );
  assert.deepEqual(statusRule.then.properties.reason, { type: "null" });
  assert.equal(statusRule.else.properties.reason.type, "string");
  assert.equal(statusRule.else.properties.reason.minLength, 1);
  assert.equal(statusRule.else.properties.builds.maxItems, 0);
  const buildRule = schema.properties.builds.items.allOf.find(
    (rule) => rule.if?.properties?.state?.enum?.includes("passed"),
  );
  assert.deepEqual(
    buildRule.then.properties.finishedAt,
    { type: "string", format: "date-time" },
  );
});

test("Buildkite CLI creates fresh nested output parents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-buildkite-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, "fresh", "nested", "snapshot.json");
  await execFileAsync(process.execPath, [
    "--import",
    new URL("./helpers/buildkite-fetch-fixture.mjs", import.meta.url).href,
    new URL("../scripts/tabellio-buildkite-builds.mjs", import.meta.url).pathname,
    "collect",
    "--repository",
    "IntelIP/Tabellio",
    "--organization",
    "intelip",
    "--pipeline",
    "tabellio",
    "--out",
    out,
  ], {
    env: { ...process.env, BUILDKITE_API_TOKEN: "test-token" },
  });
  const snapshot = JSON.parse(await readFile(out, "utf8"));
  assert.equal(snapshot.status, "available");
  assert.deepEqual(snapshot.builds, []);
});

test("Buildkite collector rejects summary and detail identity drift", async () => {
  const snapshot = await collectBuildkiteBuildSnapshot({
    ...collectorOptions(),
    request: fixtureRequest({ detailCommit: "b".repeat(40) }),
  });
  assert.equal(snapshot.status, "blocked");
});

function collectorOptions() {
  let clockCalls = 0;
  return {
    repository: "IntelIP/Tabellio",
    organization: "intelip",
    pipeline: "tabellio",
    clock: () => {
      clockCalls += 1;
      return clockCalls === 1 ? STARTED_AT : CAPTURED_AT;
    },
  };
}

function fixtureRequest({
  calls = [],
  repository = "IntelIP/Tabellio",
  organization = "intelip",
  pipeline = "tabellio",
  responsePipeline = pipeline,
  builds = [build(4)],
  jobs = [{ id: "job-1" }],
  embeddedJobs = jobs.slice(0, 1),
  artifacts = [{ id: "artifact-1" }, { id: "artifact-2" }],
  omitEmbeddedJobs = false,
  detailCommit = COMMIT,
  jobLinks = "generated",
} = {}) {
  const config = {
    repository,
    organization,
    pipeline,
    responsePipeline,
    builds,
    jobs,
    artifacts,
    omitEmbeddedJobs,
    embeddedJobs,
    detailCommit,
    jobLinks,
  };
  return async (path) => {
    calls.push(path);
    return fixtureResponse(path, config);
  };
}

function fixtureResponse(path, config) {
  const routes = [
    {
      matches: path === `/v2/organizations/${config.organization}/pipelines/${config.pipeline}`,
      response: () => ({
        repository: `https://github.com/${config.repository}.git`,
        slug: config.responsePipeline,
      }),
    },
    {
      matches: /\/builds\?.*&page=\d+$/.test(path),
      response: () => pageEnvelope(path, config.builds),
    },
    {
      matches: /\/builds\/\d+\?exclude_pipeline=true$/.test(path),
      response: () => detailResponse(path, config),
    },
    {
      matches: /\/jobs\?/.test(path),
      response: () => cursorEnvelope(path, config.jobs, config.jobLinks),
    },
    {
      matches: /\/artifacts\?.*&page=\d+$/.test(path),
      response: () => pageEnvelope(path, config.artifacts),
    },
  ];
  const route = routes.find((candidate) => candidate.matches);
  if (route === undefined) throw new Error(`Unexpected fixture request: ${path}`);
  return route.response();
}

function detailResponse(path, config) {
  const number = Number(path.match(/\/builds\/(\d+)/)[1]);
  const detail = {
    ...config.builds.find((value) => value.number === number),
    commit: config.detailCommit,
  };
  if (!config.omitEmbeddedJobs) detail.jobs = config.embeddedJobs;
  return detail;
}

function cursorEnvelope(path, values, jobLinks) {
  const url = new URL(path, "https://api.buildkite.com");
  const start = Number(url.searchParams.get("cursor") ?? 0);
  const items = values.slice(start, start + 100);
  return { items, ...cursorLinks(jobLinks, url.pathname, start, items.length, values.length) };
}

function cursorLinks(jobLinks, pathname, start, pageLength, totalLength) {
  if (jobLinks === "missing") return {};
  if (jobLinks !== "generated") return { links: jobLinks };
  return { links: { next: nextCursorPath(pathname, start, pageLength, totalLength) } };
}

function nextCursorPath(pathname, start, pageLength, totalLength) {
  if (start + pageLength >= totalLength) return null;
  return `https://api.buildkite.com${pathname}?include_retried_jobs=true&per_page=100&cursor=${start + pageLength}`;
}

function pageEnvelope(path, values) {
  const page = Number(new URL(path, "https://api.buildkite.com").searchParams.get("page"));
  const start = (page - 1) * 100;
  const body = values.slice(start, start + 100);
  return { body, nextPage: start + body.length < values.length };
}

function build(number) {
  return {
    number,
    commit: COMMIT,
    state: "passed",
    created_at: "2026-07-25T11:00:00.000Z",
    finished_at: "2026-07-25T11:02:00.000Z",
  };
}

function availableSnapshot() {
  return {
    schemaVersion: "tabellio-buildkite-build-snapshot/v0.1",
    repository: "IntelIP/Tabellio",
    organization: "intelip",
    pipeline: "tabellio",
    capturedAt: CAPTURED_AT,
    status: "available",
    reason: null,
    builds: [{
      number: 4,
      commit: COMMIT,
      state: "passed",
      createdAt: "2026-07-25T11:00:00.000Z",
      finishedAt: "2026-07-25T11:02:00.000Z",
      jobCount: 1,
      artifactCount: 2,
    }],
  };
}
