import { readFileSync } from "node:fs";

import { isJsonDateTime, validateJsonSchema } from "./json-schema-validator.mjs";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const STATE_GROUPS = new Set(["backlog", "unstarted", "started", "completed", "cancelled"]);
const SCHEMA_VERSION = "tabellio-plane-work-items/v0.1";
const MAX_PAGES = 100;
const MAX_ITEMS = 10_000;
const STATE_REQUEST_CONCURRENCY = 8;
const SCHEMA = JSON.parse(readFileSync(
  new URL("../../schemas/plane-work-item-snapshot.v0.1.schema.json", import.meta.url),
  "utf8",
));
export async function collectPlaneWorkItemSnapshot({ workspace, capturedAt, request }) {
  if (!/^[a-z0-9-]{1,100}$/.test(workspace ?? "") || !isJsonDateTime(capturedAt) || typeof request !== "function") throw new Error("Plane collector requires workspace, capturedAt, and request.");
  try {
    const projects = await collectAll(`/api/v1/workspaces/${workspace}/projects/?per_page=100`, request);
    const items = await collectAll(`/api/v1/workspaces/${workspace}/work-items/?per_page=100&fields=id,project,state,sequence_id,created_at,updated_at,target_date`, request);
    const normalizedProjects = projects.map(normalizeProject);
    if (normalizedProjects.some((project) => project === null)) throw new Error("Plane project response has unsupported fields.");
    const states = (await mapWithConcurrency(normalizedProjects, STATE_REQUEST_CONCURRENCY, async (project) =>
      (await collectAll(`/api/v1/workspaces/${workspace}/projects/${project.id}/states/?per_page=100`, request))
        .map((state) => normalizeState(state, project.id))
    )).flat();
    if (states.some((state) => state === null)) throw new Error("Plane state response has unsupported fields.");
    const workItems = items.map(normalizeItem);
    if (workItems.some((item) => item === null)) throw new Error("Plane work-item response has unsupported fields.");
    return validatePlaneWorkItemSnapshot({ schemaVersion: SCHEMA_VERSION, workspace, capturedAt, status: "available", reason: null,
      projects: normalizedProjects, states, workItems });
  } catch { return validatePlaneWorkItemSnapshot({ schemaVersion: SCHEMA_VERSION, workspace, capturedAt, status: "blocked", reason: "Plane work-item collection unavailable.", projects: [], states: [], workItems: [] }); }
}
async function mapWithConcurrency(values, concurrency, operation) {
  const output = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await operation(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}
export function validatePlaneWorkItemSnapshot(snapshot) {
  const errors = validateJsonSchema(snapshot, SCHEMA);
  if (errors.length) throw new Error(`Invalid Plane work-item snapshot: ${errors.join("; ")}`);
  if ((snapshot.status === "available") !== (snapshot.reason === null)) throw new Error("Plane snapshot status and reason conflict.");
  if (snapshot.status === "blocked" && (snapshot.projects.length || snapshot.states.length || snapshot.workItems.length)) throw new Error("Blocked Plane snapshot cannot contain evidence.");
  const projects = new Set(snapshot.projects.map((project) => project.id));
  const projectIdentifiers = new Set(snapshot.projects.map((project) => project.identifier));
  const states = new Set(snapshot.states.map((state) => state.id));
  const items = new Set(snapshot.workItems.map((item) => item.id));
  const itemKeys = new Set(snapshot.workItems.map((item) => `${item.projectId}:${item.sequenceNumber}`));
  if (projects.size !== snapshot.projects.length || projectIdentifiers.size !== snapshot.projects.length || states.size !== snapshot.states.length || items.size !== snapshot.workItems.length || itemKeys.size !== snapshot.workItems.length) throw new Error("Plane snapshot IDs and project identifiers must be unique, including delivery keys.");
  const stateById = new Map(snapshot.states.map((state) => [state.id, state]));
  if (snapshot.states.some((state) => !projects.has(state.projectId)) || snapshot.workItems.some((item) => !projects.has(item.projectId) || !states.has(item.stateId) || stateById.get(item.stateId).projectId !== item.projectId)) throw new Error("Plane snapshot contains dangling or cross-project state references.");
  if (snapshot.workItems.some((item) => Date.parse(item.createdAt) > Date.parse(item.updatedAt) || Date.parse(item.updatedAt) > Date.parse(snapshot.capturedAt))) throw new Error("Plane work-item timestamps must satisfy createdAt <= updatedAt <= capturedAt.");
  return snapshot;
}
async function collectAll(path, request) {
  const output = [];
  const cursors = new Set();
  let next = path;
  for (let pageNumber = 1; next && pageNumber <= MAX_PAGES; pageNumber += 1) {
    const page = await request(next);
    if (!Array.isArray(page?.results)) throw new Error("Unexpected Plane response.");
    output.push(...page.results);
    if (output.length > MAX_ITEMS) throw new Error("Plane collection item limit exceeded.");
    if (page.next_page_results !== true) return output;
    const cursor = page.next_cursor;
    if (typeof cursor !== "string" || cursor.length === 0 || cursors.has(cursor)) {
      throw new Error("Plane pagination cursor is missing or repeated.");
    }
    cursors.add(cursor);
    next = `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
  }
  if (next) throw new Error("Plane collection page limit exceeded.");
  return output;
}
function normalizeProject(project) { return UUID.test(project?.id ?? "") && typeof project.identifier === "string" && project.identifier.length > 0 && project.identifier.length <= 32 ? { id: project.id, identifier: project.identifier } : null; }
function normalizeState(state, projectId) { return UUID.test(state?.id ?? "") && typeof state.group === "string" && STATE_GROUPS.has(state.group) ? { id: state.id, projectId, group: state.group } : null; }
function normalizeItem(item) { if (!UUID.test(item?.id ?? "") || !UUID.test(item?.project ?? "") || !UUID.test(item?.state ?? "") || !Number.isInteger(item?.sequence_id) || item.sequence_id < 1 || !isJsonDateTime(item?.created_at) || !isJsonDateTime(item?.updated_at)) return null; return { id:item.id, projectId:item.project, stateId:item.state, sequenceNumber:item.sequence_id, createdAt:item.created_at, updatedAt:item.updated_at, targetDate: typeof item.target_date === "string" ? item.target_date : null }; }
