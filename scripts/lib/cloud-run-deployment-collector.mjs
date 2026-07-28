import { createHash } from "node:crypto";

import { validateDeploymentReceipt } from "./deployment-receipt.mjs";
import { canonicalRepositoryId, sameRepository } from "./portable-evidence.mjs";
import { canonicalDateTime } from "./strict-date-time.mjs";

const SERVICE = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const PROJECT = /^[a-z][a-z0-9-]{0,62}$/;
const REGION = /^[a-z0-9-]{1,63}$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export async function collectCloudRunDeploymentReceipt({
  repository,
  environment,
  service,
  project,
  region,
  capturedAt = null,
  clock = () => new Date().toISOString(),
  request,
}) {
  const input = { repository, environment, service, project, region, capturedAt, clock, request };
  assertInput(input);
  try {
    const payload = await request();
    const observedAt = capturedAt ?? clock();
    const revision = servingRevision(payload);
    return availableResult({ ...input, observedAt }, revision);
  } catch {
    return blockedResult();
  }
}

function assertInput({ repository, environment, service, project, region, capturedAt, clock, request }) {
  ensure(canonicalRepositoryId(repository) !== null, "Cloud Run collector repository is invalid.");
  ensure(ENVIRONMENT.test(String(environment)), "Cloud Run collector environment is invalid.");
  ensure(SERVICE.test(String(service)), "Cloud Run collector service is invalid.");
  ensure(PROJECT.test(String(project)), "Cloud Run collector project is invalid.");
  ensure(REGION.test(String(region)), "Cloud Run collector region is invalid.");
  if (capturedAt !== null) assertDateTime(capturedAt);
  ensure(typeof clock === "function", "Cloud Run collector clock is invalid.");
  ensure(typeof request === "function", "Cloud Run collector request is invalid.");
}

function availableResult({ repository, environment, service, project, region, observedAt }, revision) {
  const metadata = Object(revision).metadata;
  const commit = Object(Object(metadata).labels)["commit-sha"];
  const sourceRepository = Object(Object(metadata).annotations)["tabellio.dev/source-repository"];
  const deployedAt = canonicalDateTime(Object(metadata).creationTimestamp);
  const revisionName = Object(metadata).name;
  ensure(OID.test(String(commit)), "Cloud Run serving revision lacks exact source evidence.");
  ensure(sameRepository(sourceRepository, repository), "Cloud Run serving revision repository is invalid.");
  assertDateTime(deployedAt);
  ensure(SERVICE.test(String(revisionName)), "Cloud Run serving revision name is invalid.");
  const resource = `${project}:${region}:${service}:${revisionName}`;
  return {
    status: "available",
    reason: null,
    receipt: validateDeploymentReceipt({
      schemaVersion: "tabellio-deployment-receipt/v0.1",
      id: `cloud-run:${digest(resource)}`,
      repository,
      environment,
      commit,
      status: "passed",
      deployedAt,
      observedAt,
      provider: "cloud-run",
      externalId: resource,
      releaseTag: null,
      provenancePointer: `cloud-run:projects/${project}/locations/${region}/services/${service}/revisions/${revisionName}`,
    }),
  };
}

function servingRevision(payload) {
  const revision = payload?.revision;
  const revisionName = revision?.metadata?.name;
  const traffic = payload?.service?.status?.traffic;
  ensure(Array.isArray(traffic), "Cloud Run service traffic is invalid.");
  const serving = traffic.some((entry) =>
    entry?.percent === 100 && entry?.revisionName === revisionName
  );
  ensure(serving, "Cloud Run service has no single serving revision.");
  return revision;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function blockedResult() {
  return {
    status: "blocked",
    reason: "Cloud Run runtime receipt unavailable or lacks exact source evidence.",
    receipt: null,
  };
}

function assertDateTime(value) {
  ensure(canonicalDateTime(value) !== null, "Cloud Run timestamp is invalid.");
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
