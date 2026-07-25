import { readFileSync } from "node:fs";

import { isJsonDateTime, validateJsonSchema } from "./json-schema-validator.mjs";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const STATE_GROUPS = new Set(["backlog", "unstarted", "started", "completed", "cancelled"]);
const SCHEMA_VERSION = "tabellio-plane-work-items/v0.1";
const SCHEMA = JSON.parse(readFileSync(
  new URL("../../schemas/plane-work-item-snapshot.v0.1.schema.json", import.meta.url),
  "utf8",
));
export async function collectPlaneWorkItemSnapshot({ workspace, capturedAt, request }) {
  if (!/^[a-z0-9-]{1,100}$/.test(workspace ?? "") || !isJsonDateTime(capturedAt) || typeof request !== "function") throw new Error("Plane collector requires workspace, capturedAt, and request.");
  try {
    const projects = await collectAll(`/api/v1/workspaces/${workspace}/projects/?per_page=100`, request);
    const items = await collectAll(`/api/v1/workspaces/${workspace}/work-items/?per_page=100&fields=id,project,state,sequence_id,created_at,updated_at,target_date`, request);
    const normalizedProjects = projects.map(normalizeProject).filter(Boolean);
    const states = (await Promise.all(normalizedProjects.map(async (project) =>
      (await collectAll(`/api/v1/workspaces/${workspace}/projects/${project.id}/states/?per_page=100`, request))
        .map((state) => normalizeState(state, project.id)).filter(Boolean)
    ))).flat();
    return validatePlaneWorkItemSnapshot({ schemaVersion: SCHEMA_VERSION, workspace, capturedAt, status: "available", reason: null,
      projects: normalizedProjects, states, workItems: items.map(normalizeItem).filter(Boolean) });
  } catch { return validatePlaneWorkItemSnapshot({ schemaVersion: SCHEMA_VERSION, workspace, capturedAt, status: "blocked", reason: "Plane work-item collection unavailable.", projects: [], states: [], workItems: [] }); }
}
export function validatePlaneWorkItemSnapshot(snapshot) {
  const errors = validateJsonSchema(snapshot, SCHEMA);
  if (errors.length) throw new Error(`Invalid Plane work-item snapshot: ${errors.join("; ")}`);
  if ((snapshot.status === "available") !== (snapshot.reason === null)) throw new Error("Plane snapshot status and reason conflict.");
  if (snapshot.status === "blocked" && (snapshot.projects.length || snapshot.states.length || snapshot.workItems.length)) throw new Error("Blocked Plane snapshot cannot contain evidence.");
  const projects = new Set(snapshot.projects.map((project) => project.id));
  const states = new Set(snapshot.states.map((state) => state.id));
  if (projects.size !== snapshot.projects.length || states.size !== snapshot.states.length) throw new Error("Plane snapshot IDs must be unique.");
  if (snapshot.states.some((state) => !projects.has(state.projectId)) || snapshot.workItems.some((item) => !projects.has(item.projectId) || !states.has(item.stateId))) throw new Error("Plane snapshot contains dangling project or state references.");
  return snapshot;
}
async function collectAll(path, request) { const output=[]; let next=path; while(next){const page=await request(next); if(!Array.isArray(page?.results)) throw new Error("Unexpected Plane response."); output.push(...page.results); next=page.next_page_results === true && page.next_cursor ? `${path}${path.includes("?")?"&":"?"}cursor=${encodeURIComponent(page.next_cursor)}` : null;} return output; }
function normalizeProject(project) { return UUID.test(project?.id ?? "") && typeof project.identifier === "string" && project.identifier.length > 0 && project.identifier.length <= 32 ? { id: project.id, identifier: project.identifier } : null; }
function normalizeState(state, projectId) { return UUID.test(state?.id ?? "") && typeof state.group === "string" && STATE_GROUPS.has(state.group) ? { id: state.id, projectId, group: state.group } : null; }
function normalizeItem(item) { if (!UUID.test(item?.id ?? "") || !UUID.test(item?.project ?? "") || !UUID.test(item?.state ?? "") || !Number.isInteger(item?.sequence_id) || item.sequence_id < 1 || !isJsonDateTime(item?.created_at) || !isJsonDateTime(item?.updated_at)) return null; return { id:item.id, projectId:item.project, stateId:item.state, sequenceNumber:item.sequence_id, createdAt:item.created_at, updatedAt:item.updated_at, targetDate: typeof item.target_date === "string" ? item.target_date : null }; }
