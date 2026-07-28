import { validateDeploymentReceipt } from "./deployment-receipt.mjs";
import { canonicalRepositoryId, sameRepository } from "./portable-evidence.mjs";
import { canonicalDateTime } from "./strict-date-time.mjs";

const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export async function collectVercelDeploymentReceipt({
  repository,
  environment,
  projectId,
  capturedAt = null,
  clock = () => new Date().toISOString(),
  request,
}) {
  assertInput({ repository, environment, projectId, capturedAt, clock, request });
  try {
    const payload = await request();
    const observedAt = capturedAt ?? clock();
    const deployment = selectDeployment(payload);
    return availableResult({
      repository,
      environment,
      projectId,
      observedAt,
      deployment,
    });
  } catch {
    return blockedResult();
  }
}

function assertInput({ repository, environment, projectId, capturedAt, clock, request }) {
  ensure(canonicalRepositoryId(repository) !== null, "Vercel collector repository is invalid.");
  ensure(environment === "production", "Vercel deployment evidence requires production.");
  ensure(PROJECT_ID.test(String(projectId)), "Vercel collector projectId is invalid.");
  if (capturedAt !== null) assertDateTime(capturedAt);
  ensure(typeof clock === "function", "Vercel collector clock is invalid.");
  ensure(typeof request === "function", "Vercel collector request is invalid.");
}

function selectDeployment(payload) {
  const deployments = Object(payload).deployments;
  ensure(Array.isArray(deployments), "Vercel deployments response is invalid.");
  const deployment = deployments.find(isReadyProduction);
  ensure(deployment, "Vercel deployment lacks exact source evidence.");
  return deployment;
}

function isReadyProduction(candidate) {
  if (Object(candidate).target !== "production") return false;
  if (Object(candidate).readyState !== "READY") return false;
  return DEPLOYMENT_ID.test(String(Object(candidate).uid));
}

function availableResult({ repository, environment, projectId, observedAt, deployment }) {
  const metadata = Object(deployment).meta;
  const commit = Object(metadata).githubCommitSha;
  const deployedAt = epochMillisToIso(deployment.readyAt);
  const observedRepository = `${Object(metadata).githubCommitOrg}/${Object(metadata).githubCommitRepo}`;
  ensure(OID.test(String(commit)), "Vercel deployment commit is invalid.");
  ensure(sameRepository(observedRepository, repository), "Vercel deployment repository is invalid.");
  ensure(deployedAt !== null, "Vercel deployment timestamp is invalid.");
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
      observedAt,
      provider: "vercel",
      externalId: deployment.uid,
      releaseTag: null,
      provenancePointer: `vercel:projects/${projectId}/deployments/${deployment.uid}`,
    }),
  };
}

function epochMillisToIso(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

function blockedResult() {
  return {
    status: "blocked",
    reason: "Vercel runtime receipt unavailable or lacks exact source evidence.",
    receipt: null,
  };
}

function assertDateTime(value) {
  ensure(canonicalDateTime(value) !== null, "Vercel timestamp is invalid.");
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
