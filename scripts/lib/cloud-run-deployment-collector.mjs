import { validateDeploymentReceipt } from "./deployment-receipt.mjs";
import { isJsonDateTime } from "./json-schema-validator.mjs";

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Read-only Cloud Run evidence. A receipt is emitted only when the serving
// revision carries a full immutable source OID. Short labels are not evidence.
export async function collectCloudRunDeploymentReceipt({ repository, environment, service, capturedAt, request }) {
  if (!REPOSITORY.test(repository ?? "") || !ENVIRONMENT.test(environment ?? "") || !/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(service ?? "") || !isJsonDateTime(capturedAt) || typeof request !== "function") {
    throw new Error("Cloud Run collector requires repository, environment, service, capturedAt, and request.");
  }
  try {
    const payload = await request();
    const revision = servingRevision(payload);
    const commit = revision?.metadata?.labels?.["commit-sha"];
    const deployedAt = revision?.metadata?.creationTimestamp;
    if (!revision || !OID.test(commit ?? "") || !isJsonDateTime(deployedAt)) throw new Error("Cloud Run serving revision lacks exact source evidence.");
    return {
      status: "available",
      reason: null,
      receipt: validateDeploymentReceipt({
        schemaVersion: "tabellio-deployment-receipt/v0.1",
        id: `cloud-run:${revision.metadata.name}`,
        repository,
        environment,
        commit,
        status: "passed",
        deployedAt,
        observedAt: capturedAt,
        provider: "cloud-run",
        externalId: revision.metadata.name,
        releaseTag: null,
        provenancePointer: `cloud-run://services/${service}/revisions/${revision.metadata.name}`,
      }),
    };
  } catch {
    return { status: "blocked", reason: "Cloud Run runtime receipt unavailable or lacks an exact commit.", receipt: null };
  }
}

function servingRevision(payload) {
  const service = payload?.service;
  const revision = payload?.revision;
  const traffic = Array.isArray(service?.status?.traffic) ? service.status.traffic : [];
  const entry = traffic.find((candidate) => candidate?.percent === 100 && candidate?.revisionName === revision?.metadata?.name);
  return entry ? revision : null;
}
