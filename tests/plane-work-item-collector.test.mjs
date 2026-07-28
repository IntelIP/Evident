import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  collectPlaneWorkItemSnapshot,
  validatePlaneWorkItemSnapshot,
} from "../scripts/lib/plane-work-item-collector.mjs";
import { assertNoSymlinkPath } from "../scripts/lib/output-safety.mjs";

const execFileAsync = promisify(execFile);
const CAPTURED_AT = "2026-07-25T12:00:00.000Z";
const PROJECT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_B = "22222222-2222-2222-2222-222222222222";
const STATE_A = "33333333-3333-3333-3333-333333333333";
const STATE_B = "44444444-4444-4444-4444-444444444444";
const ITEM_A = "55555555-5555-5555-5555-555555555555";
const ITEM_B = "66666666-6666-6666-6666-666666666666";

test("Plane collector normalizes complete project, state, and work-item evidence", async () => {
  const calls = [];
  const routes = new Map([
    ["/projects/?", page([project(PROJECT_A, "INTB-CORE")])],
    ["/work-items/?", page([workItem({
      stateValue: { id: STATE_A, group: "started" },
      createdAt: "2026-07-25T09:00:00Z",
      updatedAt: "2026-07-25T11:00:00.123456Z",
    })])],
  ]);
  const snapshot = await collectPlaneWorkItemSnapshot({
    workspace: "intelip",
    capturedAt: CAPTURED_AT,
    request: async (path) => {
      calls.push(path);
      return responseFor(path, routes, page([state(STATE_A)]));
    },
  });
  assert.equal(snapshot.status, "available");
  assert.deepEqual(snapshot.projects, [{ id: PROJECT_A, identifier: "INTB-CORE" }]);
  assert.equal(snapshot.states[0].projectId, PROJECT_A);
  assert.equal(snapshot.workItems[0].sequenceNumber, 261);
  assert.equal(snapshot.workItems[0].createdAt, "2026-07-25T09:00:00.000Z");
  assert.equal(snapshot.workItems[0].updatedAt, "2026-07-25T11:00:00.123Z");
  assert(calls.some((path) => path.includes(`/projects/${PROJECT_A}/states/`)));
  assert(calls.some((path) => path.includes(`/projects/${PROJECT_A}/work-items/`)));
});

test("Plane collector paginates every inventory with distinct cursors", async () => {
  const seen = [];
  const responses = paginationResponses();
  const snapshot = await collectPlaneWorkItemSnapshot({
    workspace: "intelip",
    capturedAt: CAPTURED_AT,
    request: async (path) => {
      seen.push(path);
      return responseFor(path, responses, statePageFor(path));
    },
  });
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.projects.length, 2);
  assert.equal(snapshot.workItems.length, 2);
  assert(seen.some((path) => path.includes("cursor=projects-2")));
  assert(seen.some((path) => path.includes("cursor=items-2")));
});

test("Plane collector bounds concurrent project-state requests", async () => {
  const projects = Array.from({ length: 20 }, (_, index) =>
    project(uuid(index + 1), `P${index + 1}`)
  );
  let active = 0;
  let maximum = 0;
  const snapshot = await collectPlaneWorkItemSnapshot({
    workspace: "intelip",
    capturedAt: CAPTURED_AT,
    request: async (path) => {
      if (path.includes("/projects/?")) return page(projects);
      if (path.includes("/work-items/?")) return page([]);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const projectIndex = projects.findIndex((entry) => path.includes(entry.id));
      return page([state(uuid(100 + projectIndex))]);
    },
  });
  assert.equal(snapshot.status, "available");
  assert.equal(maximum, 8);
  console.log(`plane_state_max_concurrency=${maximum}`);
});

test("Plane collector blocks repeated, missing, and unbounded cursor metadata", async () => {
  for (const response of [
    { results: [] },
    { results: [], next_page_results: true },
    { results: [], next_page_results: true, next_cursor: "" },
  ]) {
    const snapshot = await collectPlaneWorkItemSnapshot({
      workspace: "intelip",
      capturedAt: CAPTURED_AT,
      request: async () => response,
    });
    assert.equal(snapshot.status, "blocked");
  }

  let calls = 0;
  const repeated = await collectPlaneWorkItemSnapshot({
    workspace: "intelip",
    capturedAt: CAPTURED_AT,
    request: async () => {
      calls += 1;
      return page([], "same-cursor");
    },
  });
  assert.equal(repeated.status, "blocked");
  assert(calls <= 4);
  console.log("plane_page_limit=100");
});

test("Plane collector rejects contradictory pagination totals", async () => {
  for (const response of [
    { ...page([project(PROJECT_A, "INTB")]), total_results: 2 },
    { ...page([project(PROJECT_A, "INTB")]), total_pages: 2 },
    { ...page([project(PROJECT_A, "INTB")]), count: 2 },
  ]) {
    const snapshot = await collectPlaneWorkItemSnapshot({
      workspace: "intelip",
      capturedAt: CAPTURED_AT,
      request: async () => response,
    });
    assert.equal(snapshot.status, "blocked");
  }
});

test("Plane collector captures observation time after provider reads", async () => {
  let reads = 0;
  const routes = new Map([
    ["/projects/?", page([project(PROJECT_A, "INTB")])],
    ["/work-items/?", page([workItem()])],
  ]);
  const snapshot = await collectPlaneWorkItemSnapshot({
    workspace: "intelip",
    clock: () => {
      assert.equal(reads, 3);
      return CAPTURED_AT;
    },
    request: async (path) => {
      reads += 1;
      return responseFor(path, routes, page([state(STATE_A)]));
    },
  });
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.capturedAt, CAPTURED_AT);
});

test("Plane collector blocks every malformed provider row", async () => {
  const malformedRows = [
    { target: "projects", value: { id: "bad", identifier: "INTB" } },
    { target: "projects", value: project(PROJECT_A, "intb") },
    { target: "states", value: { id: STATE_A, group: "unknown" } },
    { target: "items", value: { ...workItem(), state: null } },
    { target: "items", value: { ...workItem(), updated_at: "not-a-date" } },
    { target: "items", value: { ...workItem(), target_date: "2026-02-30" } },
  ];
  for (const malformed of malformedRows) {
    const routes = malformedResponses(malformed);
    const snapshot = await collectPlaneWorkItemSnapshot({
      workspace: "intelip",
      capturedAt: CAPTURED_AT,
      request: async (path) => responseFor(path, routes, routes.get("states")),
    });
    assert.equal(snapshot.status, "blocked", malformed.target);
  }
});

test("Plane snapshot rejects duplicate IDs, identifiers, and delivery keys", () => {
  const base = availableSnapshot();
  const duplicateCases = [
    { ...base, projects: [...base.projects, { id: PROJECT_B, identifier: "INTB" }] },
    { ...base, states: [...base.states, { ...base.states[0] }] },
    { ...base, workItems: [...base.workItems, { ...base.workItems[0] }] },
    { ...base, workItems: [...base.workItems, { ...base.workItems[0], id: ITEM_B }] },
  ];
  for (const candidate of duplicateCases) {
    assert.throws(() => validatePlaneWorkItemSnapshot(candidate), /must be unique/);
  }
});

test("Plane snapshot binds states to their owning projects", () => {
  const base = availableSnapshot();
  assert.throws(() => validatePlaneWorkItemSnapshot({
    ...base,
    projects: [...base.projects, { id: PROJECT_B, identifier: "OPS" }],
    states: [...base.states, { id: STATE_B, projectId: PROJECT_B, group: "started" }],
    workItems: [{ ...base.workItems[0], stateId: STATE_B }],
  }), /cross-project state/);
  assert.throws(() => validatePlaneWorkItemSnapshot({
    ...base,
    states: [{ ...base.states[0], projectId: PROJECT_B }],
  }), /unknown project/);
});

test("Plane snapshot enforces work-item capture chronology", () => {
  const base = availableSnapshot();
  for (const item of [
    { ...base.workItems[0], createdAt: "2026-07-25T11:30:00.000Z", updatedAt: "2026-07-25T11:00:00.000Z" },
    { ...base.workItems[0], updatedAt: "2026-07-25T12:00:01.000Z" },
  ]) {
    assert.throws(() => validatePlaneWorkItemSnapshot({
      ...base,
      workItems: [item],
    }), /createdAt <= updatedAt <= capturedAt/);
  }
});

test("Plane schema matches status and project identifier contracts", async () => {
  const schema = JSON.parse(await readFile(
    "schemas/plane-work-item-snapshot.v0.1.schema.json",
    "utf8",
  ));
  assert.equal(
    schema.$defs.project.properties.identifier.pattern,
    "^[A-Z](?:[A-Z0-9]|-(?=[A-Z0-9])){0,31}$",
  );
  assert.equal(schema.allOf[0].then.properties.reason.type, "null");
  assert.equal(schema.allOf[1].then.properties.projects.maxItems, 0);
  assert(schema.$defs.safeText.allOf.length >= 10);
});

test("Plane snapshot reason matches the schema-safe 200 character boundary", () => {
  const base = {
    ...availableSnapshot(),
    status: "blocked",
    projects: [],
    states: [],
    workItems: [],
  };
  assert.throws(
    () => validatePlaneWorkItemSnapshot({ ...base, reason: "a".repeat(201) }),
    /safe reason/,
  );
  for (const reason of ["sk-proj_12345678", "~/secret"]) {
    assert.throws(
      () => validatePlaneWorkItemSnapshot({ ...base, reason }),
      /safe reason/,
    );
  }
});

test("Plane output path rejects symlinked ancestors", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-plane-output-"));
  const actual = join(root, "actual");
  const alias = join(root, "alias");
  await mkdir(actual);
  await symlink(actual, alias);
  await assert.rejects(
    () => assertNoSymlinkPath(join(alias, "snapshot.json"), "--out"),
    /symbolic-link path/,
  );
});

test("Plane CLI requires runtime credentials without exposing values", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-plane-cli-"));
  const result = await execFileAsync(process.execPath, [
    "scripts/tabellio-plane-work-items.mjs",
    "collect",
    "--workspace", "intelip",
    "--out", join(root, "snapshot.json"),
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PLANE_API_KEY: "" },
  }).then(
    () => assert.fail("Expected missing credential failure."),
    (error) => error,
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /PLANE_API_KEY is required/);
});

function availableSnapshot() {
  return {
    schemaVersion: "tabellio-plane-work-items/v0.1",
    workspace: "intelip",
    capturedAt: CAPTURED_AT,
    status: "available",
    reason: null,
    projects: [{ id: PROJECT_A, identifier: "INTB" }],
    states: [{ id: STATE_A, projectId: PROJECT_A, group: "started" }],
    workItems: [{
      id: ITEM_A,
      projectId: PROJECT_A,
      stateId: STATE_A,
      sequenceNumber: 261,
      createdAt: "2026-07-25T09:00:00.000Z",
      updatedAt: "2026-07-25T11:00:00.000Z",
      targetDate: "2026-07-31",
    }],
  };
}

function project(id, identifier) {
  return { id, identifier };
}

function state(id) {
  return { id, group: "started" };
}

function workItem({
  id = ITEM_A,
  project = PROJECT_A,
  stateId = STATE_A,
  stateValue = stateId,
  sequence = 261,
  createdAt = "2026-07-25T09:00:00.000Z",
  updatedAt = "2026-07-25T11:00:00.000Z",
} = {}) {
  return {
    id,
    project,
    state: stateValue,
    sequence_id: sequence,
    created_at: createdAt,
    updated_at: updatedAt,
    target_date: "2026-07-31",
  };
}

function page(results, cursor = null) {
  return {
    results,
    next_page_results: cursor !== null,
    next_cursor: cursor,
  };
}

function responseFor(path, routes, fallback) {
  for (const [fragment, response] of routes) {
    if (path.includes(fragment)) return response;
  }
  return fallback;
}

function paginationResponses() {
  return new Map([
    ["/projects/?per_page=100&cursor=", page([project(PROJECT_B, "OPS")])],
    ["/projects/?", page([project(PROJECT_A, "INTB")], "projects-2")],
    [`${PROJECT_A}/work-items/?per_page=100&fields=id,state,sequence_id,created_at,updated_at,target_date&cursor=items-2`, page([])],
    [`${PROJECT_A}/work-items/`, page([workItem()], "items-2")],
    [`${PROJECT_B}/work-items/`, page([workItem({
      id: ITEM_B,
      project: PROJECT_B,
      stateId: STATE_B,
      sequence: 8,
    })])],
  ]);
}

function statePageFor(path) {
  return path.includes(PROJECT_A) ? page([state(STATE_A)]) : page([state(STATE_B)]);
}

function malformedResponses({ target, value }) {
  const rows = {
    projects: project(PROJECT_A, "INTB"),
    items: workItem(),
    states: state(STATE_A),
  };
  rows[target] = value;
  return new Map([
    ["/projects/?", page([rows.projects])],
    ["/work-items/?", page([rows.items])],
    ["states", page([rows.states])],
  ]);
}

function uuid(value) {
  return `${value.toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`;
}
