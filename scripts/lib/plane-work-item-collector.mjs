import { isJsonDateTime } from "./json-schema-validator.mjs";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export async function collectPlaneWorkItemSnapshot({ workspace, capturedAt, request }) {
  if (!/^[a-z0-9-]{1,100}$/.test(workspace ?? "") || !isJsonDateTime(capturedAt) || typeof request !== "function") throw new Error("Plane collector requires workspace, capturedAt, and request.");
  try {
    const projects = await collectAll(`/api/v1/workspaces/${workspace}/projects/?per_page=100`, request);
    const items = await collectAll(`/api/v1/workspaces/${workspace}/work-items/?per_page=100&fields=id,project,state,created_at,updated_at,target_date`, request);
    return { schemaVersion: "tabellio-plane-work-items/v0.1", workspace, capturedAt, status: "available", reason: null,
      projects: projects.map(project => ({ id: project.id, identifier: project.identifier })).filter(project => UUID.test(project.id) && typeof project.identifier === "string"),
      workItems: items.map(normalizeItem).filter(Boolean) };
  } catch { return { schemaVersion: "tabellio-plane-work-items/v0.1", workspace, capturedAt, status: "blocked", reason: "Plane work-item collection unavailable.", projects: [], workItems: [] }; }
}
async function collectAll(path, request) { const output=[]; let next=path; while(next){const page=await request(next); if(!Array.isArray(page?.results)) throw new Error("Unexpected Plane response."); output.push(...page.results); next=page.next_page_results === true && page.next_cursor ? `${path}${path.includes("?")?"&":"?"}cursor=${encodeURIComponent(page.next_cursor)}` : null;} return output; }
function normalizeItem(item) { if (!UUID.test(item?.id ?? "") || !UUID.test(item?.project ?? "") || !UUID.test(item?.state ?? "") || !isJsonDateTime(item?.created_at) || !isJsonDateTime(item?.updated_at)) return null; return { id:item.id, projectId:item.project, stateId:item.state, createdAt:item.created_at, updatedAt:item.updated_at, targetDate: typeof item.target_date === "string" ? item.target_date : null }; }
