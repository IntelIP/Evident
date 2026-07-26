import { validateDeploymentReceipt } from "./deployment-receipt.mjs";
import { isJsonDateTime } from "./json-schema-validator.mjs";

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Read-only Vercel evidence. Only a production READY deployment tied to a full
// Git commit is allowed to assert runtime proof.
export async function collectVercelDeploymentReceipt({ repository, environment, projectId, capturedAt, request }) {
  if (!REPOSITORY.test(repository ?? "") || !ENVIRONMENT.test(environment ?? "") || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId ?? "") || !isJsonDateTime(capturedAt) || typeof request !== "function") {
    throw new Error("Vercel collector requires repository, environment, projectId, capturedAt, and request.");
  }
  try {
    const payload = await request();
    const deployment = Array.isArray(payload?.deployments) ? payload.deployments.find(isReadyProductionDeployment) : null;
    const commit = deployment?.meta?.githubCommitSha;
    const deployedAt = epochMillisToIso(deployment?.readyAt);
    if (!deployment || !OID.test(commit ?? "") || !deployedAt || !matchesGitHubRepository(deployment.meta, repository)) throw new Error("Vercel deployment lacks exact source evidence.");
    return {
      status: "available",
      reason: null,
      receipt: validateDeploymentReceipt({
        schemaVersion: "tabellio-deployment-receipt/v0.1",
        id: `vercel:${deployment.uid}`,
        repository,
        environment,
        commit,
        status: "passed",
        deployedAt,
        observedAt: capturedAt,
        provider: "vercel",
        externalId: deployment.uid,
        releaseTag: null,
        provenancePointer: `vercel://projects/${projectId}/deployments/${deployment.uid}`,
      }),
    };
  } catch {
    return { status: "blocked", reason: "Vercel runtime receipt unavailable or lacks an exact commit.", receipt: null };
  }
}

function isReadyProductionDeployment(candidate) {
  return candidate?.target === "production" && candidate?.readyState === "READY" && typeof candidate?.uid === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(candidate.uid);
}
function epochMillisToIso(value) {
  return Number.isInteger(value) && value > 0 ? new Date(value).toISOString() : null;
}
function matchesGitHubRepository(meta, repository) {
  const observed = `${meta?.githubCommitOrg ?? ""}/${meta?.githubCommitRepo ?? ""}`;
  return observed.toLowerCase() === repository.toLowerCase();
}
