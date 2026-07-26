import { validateDeploymentReceipt } from "./deployment-receipt.mjs";
import { isJsonDateTime } from "./json-schema-validator.mjs";

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Read-only Cloud Run evidence. A receipt is emitted only when the serving
// revision carries a full immutable source OID. Short labels are not evidence.
export async function collectCloudRunDeploymentReceipt({ repository, environment, service, project, region, capturedAt, request }) {
  const input = { repository, environment, service, project, region, capturedAt, request };
  if (!validCollectorInput(input)) {
    throw new Error("Cloud Run collector requires repository, environment, service, project, region, capturedAt, and request.");
  }
  try {
    const payload = await request();
    const revision = servingRevision(payload);
    return availableResult(input, revision);
  } catch {
    return { status: "blocked", reason: "Cloud Run runtime receipt unavailable or lacks an exact commit.", receipt: null };
  }
}

function validCollectorInput({ repository, environment, service, project, region, capturedAt, request }) {
  return REPOSITORY.test(repository ?? "")
    && ENVIRONMENT.test(environment ?? "")
    && /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(service ?? "")
    && /^[a-z][a-z0-9-]{0,62}$/.test(project ?? "")
    && /^[a-z0-9-]{1,63}$/.test(region ?? "")
    && isJsonDateTime(capturedAt)
    && typeof request === "function";
}

function availableResult({ repository, environment, service, project, region, capturedAt }, revision) {
  const commit = revision?.metadata?.labels?.["commit-sha"];
  const sourceRepository = revision?.metadata?.annotations?.["tabellio.dev/source-repository"];
  const deployedAt = revision?.metadata?.creationTimestamp;
  if (!revision || !OID.test(commit ?? "") || !sameRepository(sourceRepository, repository) || !isJsonDateTime(deployedAt)) {
    throw new Error("Cloud Run serving revision lacks exact source evidence.");
  }
  const resource = `${project}:${region}:${service}:${revision.metadata.name}`;
  return {
    status: "available",
    reason: null,
    receipt: validateDeploymentReceipt({
      schemaVersion: "tabellio-deployment-receipt/v0.1",
      id: `cloud-run:${resource}`,
      repository,
      environment,
      commit,
      status: "passed",
      deployedAt,
      observedAt: capturedAt,
      provider: "cloud-run",
      externalId: resource,
      releaseTag: null,
      provenancePointer: `cloud-run://projects/${project}/locations/${region}/services/${service}/revisions/${revision.metadata.name}`,
    }),
  };
}

function servingRevision(payload) {
  const service = payload?.service;
  const revision = payload?.revision;
  const traffic = Array.isArray(service?.status?.traffic) ? service.status.traffic : [];
  const entry = servingTrafficEntry(traffic, revision?.metadata?.name);
  return entry ? revision : null;
}

function servingTrafficEntry(traffic, revisionName) {
  for (const candidate of traffic) {
    if (candidate?.percent === 100 && candidate?.revisionName === revisionName) return candidate;
  }
  return null;
}

function sameRepository(left, right) {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}
