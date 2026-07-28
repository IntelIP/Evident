import { boundedMap } from "./bounded-map.mjs";
import { contract } from "./contract-checks.mjs";
import { isSafeProviderVersion } from "./portable-evidence.mjs";

const VERSION = "tabellio-plane-work-items/v0.1";
const WORKSPACE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const PROJECT_IDENTIFIER = /^[A-Z](?:[A-Z0-9]|-(?=[A-Z0-9])){0,31}$/;
const PROVIDER_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const STATE_GROUPS = new Set([
  "backlog",
  "unstarted",
  "started",
  "completed",
  "cancelled",
]);
const MAX_PAGES = 100;
const MAX_ITEMS = 10_000;
const STATE_REQUEST_CONCURRENCY = 8;

export async function collectPlaneWorkItemSnapshot({
  workspace,
  capturedAt = null,
  clock = () => new Date().toISOString(),
  request,
}) {
  assertCollectorOptions({ workspace, capturedAt, clock, request });
  let observedAt = capturedAt;
  try {
    const projectRows = await collectAll(
      `/api/v1/workspaces/${workspace}/projects/?per_page=100`,
      request,
    );
    const projects = projectRows.map(normalizeProject);
    const workItemBudget = createBudget(MAX_ITEMS);
    const projectEvidence = await boundedMap(
      projects,
      STATE_REQUEST_CONCURRENCY,
      (project) => collectProjectEvidence({
        workspace,
        project,
        request,
        workItemBudget,
      }),
    );
    observedAt ??= clock();
    assertDateTime(observedAt, "Plane collector capturedAt");
    return validatePlaneWorkItemSnapshot({
      schemaVersion: VERSION,
      workspace,
      capturedAt: observedAt,
      status: "available",
      reason: null,
      projects,
      states: projectEvidence.flatMap((entry) => entry.states),
      workItems: projectEvidence.flatMap((entry) => entry.workItems),
    });
  } catch {
    observedAt ??= safeClock(clock);
    return validatePlaneWorkItemSnapshot(blockedSnapshot({ workspace, capturedAt: observedAt }));
  }
}

export function validatePlaneWorkItemSnapshot(snapshot) {
  assertSnapshotShape(snapshot);
  assertStatusShape(snapshot);
  snapshot.projects.forEach(assertProject);
  snapshot.states.forEach(assertState);
  snapshot.workItems.forEach((item) => assertWorkItem(item, snapshot.capturedAt));
  assertUniqueEvidence(snapshot);
  assertReferences(snapshot);
  return snapshot;
}

function assertCollectorOptions({ workspace, capturedAt, clock, request }) {
  ensure(WORKSPACE.test(workspace ?? ""), "Plane collector requires a safe workspace.");
  if (capturedAt !== null) assertDateTime(capturedAt, "Plane collector capturedAt");
  ensure(typeof clock === "function", "Plane collector requires a clock function.");
  ensure(typeof request === "function", "Plane collector requires a request function.");
}

async function collectProjectEvidence({ workspace, project, request, workItemBudget }) {
  const [states, workItems] = await Promise.all([
    collectProjectStates({ workspace, project, request }),
    collectProjectWorkItems({ workspace, project, request, workItemBudget }),
  ]);
  return { states, workItems };
}

async function collectProjectStates({ workspace, project, request }) {
  const rows = await collectAll(
    `/api/v1/workspaces/${workspace}/projects/${project.id}/states/?per_page=100`,
    request,
  );
  return rows.map((state) => normalizeState(state, project.id));
}

async function collectProjectWorkItems({ workspace, project, request, workItemBudget }) {
  const rows = await collectAll(
    `/api/v1/workspaces/${workspace}/projects/${project.id}/work-items/?per_page=100&fields=id,state,sequence_id,created_at,updated_at,target_date`,
    request,
    { budget: workItemBudget },
  );
  return rows.map((item) => normalizeWorkItem(item, project.id));
}

async function collectAll(path, request, { budget = null } = {}) {
  const output = [];
  const cursors = new Set();
  let next = path;
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const page = await request(next);
    const pageResult = normalizePage(page);
    budget?.consume(pageResult.results.length);
    output.push(...pageResult.results);
    ensure(output.length <= MAX_ITEMS, "Plane collection item limit exceeded.");
    assertPaginationTotals(
      page,
      pageNumber,
      output.length,
      pageResult.results.length,
      pageResult.hasNext,
    );
    if (!pageResult.hasNext) return output;
    ensure(!cursors.has(pageResult.cursor), "Plane pagination cursor is repeated.");
    cursors.add(pageResult.cursor);
    next = withCursor(path, pageResult.cursor);
  }
  throw new Error("Plane collection page limit exceeded.");
}

function assertPaginationTotals(page, pageNumber, collectedCount, pageCount, hasNext) {
  const totalResults = optionalCount(page.total_results, "total_results");
  const totalPages = optionalCount(page.total_pages, "total_pages");
  const count = optionalCount(page.count, "count");
  assertTotalResults(totalResults, collectedCount, hasNext);
  assertTotalPages(totalPages, pageNumber, hasNext);
  assertPageCount(count, pageCount);
}

function assertTotalResults(total, collected, hasNext) {
  if (total === null) return;
  const matches = hasNext ? collected < total : collected === total;
  ensure(matches, "Plane pagination totals are contradictory.");
}

function assertTotalPages(total, pageNumber, hasNext) {
  if (total === null) return;
  if (!hasNext || total === 0) return;
  ensure(pageNumber < total, "Plane pagination totals are contradictory.");
}

function assertPageCount(count, pageCount) {
  if (count === null) return;
  ensure(count === pageCount, "Plane pagination totals are contradictory.");
}

function optionalCount(value, label) {
  if (value === undefined || value === null) return null;
  ensure(
    Number.isSafeInteger(value) && value >= 0,
    `Plane pagination ${label} is invalid.`,
  );
  return value;
}

function createBudget(limit) {
  let remaining = limit;
  return {
    consume(count) {
      ensure(count <= remaining, "Plane collection item limit exceeded.");
      remaining -= count;
    },
  };
}

function normalizePage(page) {
  contract.object(page, "Plane page");
  ensure(Array.isArray(page.results), "Unexpected Plane response.");
  ensure(
    typeof page.next_page_results === "boolean",
    "Plane pagination metadata is incomplete.",
  );
  if (!page.next_page_results) {
    return { results: page.results, hasNext: false, cursor: null };
  }
  ensure(
    typeof page.next_cursor === "string" && page.next_cursor.length > 0,
    "Plane pagination metadata is incomplete.",
  );
  return { results: page.results, hasNext: true, cursor: page.next_cursor };
}

function withCursor(path, cursor) {
  return `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
}

function normalizeProject(project) {
  const id = normalizedUuid(Object(project).id);
  const identifier = Object(project).identifier;
  ensure(id !== null, "Plane project response has unsupported fields.");
  ensure(
    typeof identifier === "string" && PROJECT_IDENTIFIER.test(identifier),
    "Plane project response has unsupported fields.",
  );
  return { id, identifier };
}

function normalizeState(state, projectId) {
  const id = normalizedUuid(Object(state).id);
  const group = Object(state).group;
  ensure(id !== null, "Plane state response has unsupported fields.");
  ensure(STATE_GROUPS.has(group), "Plane state response has unsupported fields.");
  return { id, projectId, group };
}

function normalizeWorkItem(item, projectId) {
  const row = Object(item);
  const id = normalizedUuid(row.id);
  const normalizedProjectId = normalizedUuid(projectId);
  const stateId = normalizedUuid(referenceId(row.state));
  ensure(id !== null, "Plane work-item response has unsupported fields.");
  ensure(normalizedProjectId !== null, "Plane work-item response has unsupported fields.");
  ensure(stateId !== null, "Plane work-item response has unsupported fields.");
  ensure(
    Number.isSafeInteger(row.sequence_id) && row.sequence_id > 0,
    "Plane work-item response has unsupported fields.",
  );
  const createdAt = canonicalDateTime(row.created_at, "Plane work-item createdAt");
  const updatedAt = canonicalDateTime(row.updated_at, "Plane work-item updatedAt");
  ensure(
    row.target_date === null || isDate(row.target_date),
    "Plane work-item response has unsupported fields.",
  );
  return {
    id,
    projectId: normalizedProjectId,
    stateId,
    sequenceNumber: row.sequence_id,
    createdAt,
    updatedAt,
    targetDate: row.target_date,
  };
}

function referenceId(value) {
  if (typeof value === "string") return value;
  return Object(value).id;
}

function normalizedUuid(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return UUID.test(normalized) ? normalized : null;
}

function assertSnapshotShape(snapshot) {
  contract.object(snapshot, "Plane snapshot");
  contract.exactKeys(snapshot, [
    "schemaVersion",
    "workspace",
    "capturedAt",
    "status",
    "reason",
    "projects",
    "states",
    "workItems",
  ], "Plane snapshot");
  contract.equals(snapshot.schemaVersion, VERSION, "Plane snapshot schemaVersion");
  ensure(WORKSPACE.test(snapshot.workspace ?? ""), "Plane snapshot workspace is invalid.");
  assertDateTime(snapshot.capturedAt, "Plane snapshot capturedAt");
  contract.member(snapshot.status, ["available", "blocked"], "Plane snapshot status");
  ensure(Array.isArray(snapshot.projects), "Plane snapshot projects are invalid.");
  ensure(Array.isArray(snapshot.states), "Plane snapshot states are invalid.");
  ensure(Array.isArray(snapshot.workItems), "Plane snapshot workItems are invalid.");
  ensure(snapshot.projects.length <= MAX_ITEMS, "Plane snapshot projects exceed the limit.");
  ensure(snapshot.states.length <= MAX_ITEMS, "Plane snapshot states exceed the limit.");
  ensure(snapshot.workItems.length <= MAX_ITEMS, "Plane snapshot workItems exceed the limit.");
}

function assertStatusShape(snapshot) {
  if (snapshot.status === "available") {
    ensure(snapshot.reason === null, "Available Plane snapshot cannot have a reason.");
    return;
  }
  ensure(
    typeof snapshot.reason === "string" && isSafeProviderVersion(snapshot.reason),
    "Blocked Plane snapshot requires a safe reason.",
  );
  ensure(snapshot.projects.length === 0, "Blocked Plane snapshot cannot contain evidence.");
  ensure(snapshot.states.length === 0, "Blocked Plane snapshot cannot contain evidence.");
  ensure(snapshot.workItems.length === 0, "Blocked Plane snapshot cannot contain evidence.");
}

function assertProject(project) {
  contract.object(project, "Plane project");
  contract.exactKeys(project, ["id", "identifier"], "Plane project");
  ensure(UUID.test(project.id ?? ""), "Plane project ID is invalid.");
  ensure(
    PROJECT_IDENTIFIER.test(project.identifier ?? ""),
    "Plane project identifier is invalid.",
  );
}

function assertState(state) {
  contract.object(state, "Plane state");
  contract.exactKeys(state, ["id", "projectId", "group"], "Plane state");
  ensure(UUID.test(state.id ?? ""), "Plane state ID is invalid.");
  ensure(UUID.test(state.projectId ?? ""), "Plane state projectId is invalid.");
  ensure(STATE_GROUPS.has(state.group), "Plane state group is invalid.");
}

function assertWorkItem(item, capturedAt) {
  contract.object(item, "Plane work item");
  contract.exactKeys(item, [
    "id",
    "projectId",
    "stateId",
    "sequenceNumber",
    "createdAt",
    "updatedAt",
    "targetDate",
  ], "Plane work item");
  ensure(UUID.test(item.id ?? ""), "Plane work-item ID is invalid.");
  ensure(UUID.test(item.projectId ?? ""), "Plane work-item projectId is invalid.");
  ensure(UUID.test(item.stateId ?? ""), "Plane work-item stateId is invalid.");
  assertSequenceNumber(item.sequenceNumber);
  assertDateTime(item.createdAt, "Plane work-item createdAt");
  assertDateTime(item.updatedAt, "Plane work-item updatedAt");
  assertTargetDate(item.targetDate);
  assertChronology(item, capturedAt);
}

function assertSequenceNumber(value) {
  ensure(Number.isSafeInteger(value), "Plane work-item sequenceNumber is invalid.");
  ensure(value > 0, "Plane work-item sequenceNumber is invalid.");
}

function assertTargetDate(value) {
  if (value === null) return;
  ensure(isDate(value), "Plane work-item targetDate is invalid.");
}

function assertChronology(item, capturedAt) {
  const created = Date.parse(item.createdAt);
  const updated = Date.parse(item.updatedAt);
  ensure(created <= updated, "Plane work-item timestamps must satisfy createdAt <= updatedAt <= capturedAt.");
  ensure(updated <= Date.parse(capturedAt), "Plane work-item timestamps must satisfy createdAt <= updatedAt <= capturedAt.");
}

function assertUniqueEvidence(snapshot) {
  assertUnique(snapshot.projects.map((project) => project.id), "Plane project IDs");
  assertUnique(
    snapshot.projects.map((project) => project.identifier),
    "Plane project identifiers",
  );
  assertUnique(snapshot.states.map((state) => state.id), "Plane state IDs");
  assertUnique(snapshot.workItems.map((item) => item.id), "Plane work-item IDs");
  assertUnique(
    snapshot.workItems.map((item) => `${item.projectId}:${item.sequenceNumber}`),
    "Plane work-item delivery keys",
  );
}

function assertUnique(values, label) {
  ensure(new Set(values).size === values.length, `${label} must be unique.`);
}

function assertReferences(snapshot) {
  const projects = new Set(snapshot.projects.map((project) => project.id));
  const states = new Map(snapshot.states.map((state) => [state.id, state.projectId]));
  snapshot.states.forEach((state) =>
    ensure(projects.has(state.projectId), "Plane state references an unknown project.")
  );
  snapshot.workItems.forEach((item) => {
    ensure(projects.has(item.projectId), "Plane work item references an unknown project.");
    ensure(states.has(item.stateId), "Plane work item references an unknown state.");
    ensure(
      states.get(item.stateId) === item.projectId,
      "Plane work item references a cross-project state.",
    );
  });
}

function blockedSnapshot({ workspace, capturedAt }) {
  return {
    schemaVersion: VERSION,
    workspace,
    capturedAt,
    status: "blocked",
    reason: "Plane work-item collection unavailable.",
    projects: [],
    states: [],
    workItems: [],
  };
}

function assertDateTime(value, label) {
  ensure(isDateTime(value), `${label} is invalid.`);
}

function canonicalDateTime(value, label) {
  const match = typeof value === "string" ? PROVIDER_DATE_TIME.exec(value) : null;
  ensure(match !== null && hasValidDateTimeParts(match), `${label} is invalid.`);
  const parsed = Date.parse(value);
  ensure(Number.isFinite(parsed), `${label} is invalid.`);
  return new Date(parsed).toISOString();
}

function hasValidDateTimeParts(match) {
  const expected = match.slice(1, 7).map(Number);
  const [year, month, day, hour, minute, second] = expected;
  if (year <= 0) return false;
  const wallClock = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const actual = [
    wallClock.getUTCFullYear(),
    wallClock.getUTCMonth() + 1,
    wallClock.getUTCDate(),
    wallClock.getUTCHours(),
    wallClock.getUTCMinutes(),
    wallClock.getUTCSeconds(),
  ];
  return expected.every((value, index) => value === actual[index])
    && hasValidOffset(match[8]);
}

function hasValidOffset(value) {
  if (value === "Z") return true;
  const [hours, minutes] = value.slice(1).split(":").map(Number);
  return hours <= 23 && minutes <= 59;
}

function isDateTime(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString() === value;
}

function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function safeClock(clock) {
  const value = clock();
  assertDateTime(value, "Plane collector capturedAt");
  return value;
}
