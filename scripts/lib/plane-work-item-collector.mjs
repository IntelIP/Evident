import { boundedMap } from "./bounded-map.mjs";
import { contract } from "./contract-checks.mjs";
import { isSafeProviderText } from "./portable-evidence.mjs";

const VERSION = "tabellio-plane-work-items/v0.1";
const WORKSPACE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const PROJECT_IDENTIFIER = /^[A-Z][A-Z0-9]{0,31}$/;
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
  capturedAt,
  request,
}) {
  assertCollectorOptions({ workspace, capturedAt, request });
  try {
    const [projectRows, itemRows] = await Promise.all([
      collectAll(`/api/v1/workspaces/${workspace}/projects/?per_page=100`, request),
      collectAll(
        `/api/v1/workspaces/${workspace}/work-items/?per_page=100&fields=id,project,state,sequence_id,created_at,updated_at,target_date`,
        request,
      ),
    ]);
    const projects = projectRows.map(normalizeProject);
    const statePages = await boundedMap(
      projects,
      STATE_REQUEST_CONCURRENCY,
      (project) => collectProjectStates({ workspace, project, request }),
    );
    const workItems = itemRows.map(normalizeWorkItem);
    return validatePlaneWorkItemSnapshot({
      schemaVersion: VERSION,
      workspace,
      capturedAt,
      status: "available",
      reason: null,
      projects,
      states: statePages.flat(),
      workItems,
    });
  } catch {
    return validatePlaneWorkItemSnapshot(blockedSnapshot({ workspace, capturedAt }));
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

function assertCollectorOptions({ workspace, capturedAt, request }) {
  ensure(WORKSPACE.test(workspace ?? ""), "Plane collector requires a safe workspace.");
  assertDateTime(capturedAt, "Plane collector capturedAt");
  ensure(typeof request === "function", "Plane collector requires a request function.");
}

async function collectProjectStates({ workspace, project, request }) {
  const rows = await collectAll(
    `/api/v1/workspaces/${workspace}/projects/${project.id}/states/?per_page=100`,
    request,
  );
  return rows.map((state) => normalizeState(state, project.id));
}

async function collectAll(path, request) {
  const output = [];
  const cursors = new Set();
  let next = path;
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const page = await request(next);
    const pageResult = normalizePage(page);
    output.push(...pageResult.results);
    ensure(output.length <= MAX_ITEMS, "Plane collection item limit exceeded.");
    if (!pageResult.hasNext) return output;
    ensure(!cursors.has(pageResult.cursor), "Plane pagination cursor is repeated.");
    cursors.add(pageResult.cursor);
    next = withCursor(path, pageResult.cursor);
  }
  throw new Error("Plane collection page limit exceeded.");
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

function normalizeWorkItem(item) {
  const row = Object(item);
  const id = normalizedUuid(row.id);
  const projectId = normalizedUuid(row.project);
  const stateId = normalizedUuid(row.state);
  ensure(id !== null, "Plane work-item response has unsupported fields.");
  ensure(projectId !== null, "Plane work-item response has unsupported fields.");
  ensure(stateId !== null, "Plane work-item response has unsupported fields.");
  ensure(
    Number.isSafeInteger(row.sequence_id) && row.sequence_id > 0,
    "Plane work-item response has unsupported fields.",
  );
  assertDateTime(row.created_at, "Plane work-item createdAt");
  assertDateTime(row.updated_at, "Plane work-item updatedAt");
  ensure(
    row.target_date === null || isDate(row.target_date),
    "Plane work-item response has unsupported fields.",
  );
  return {
    id,
    projectId,
    stateId,
    sequenceNumber: row.sequence_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    targetDate: row.target_date,
  };
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
  ensure(isSafeProviderText(snapshot.reason), "Blocked Plane snapshot requires a safe reason.");
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
