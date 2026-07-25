import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { validateProviderSnapshot } from "./analytics.mjs";
import { validateBuildkiteBuildSnapshot } from "./buildkite-build-collector.mjs";
import { validateDeploymentReceipt } from "./deployment-receipt.mjs";
import { validateGitHubReleaseSnapshot } from "./github-release-collector.mjs";
import { isJsonDateTime, validateJsonSchema } from "./json-schema-validator.mjs";
import { validatePlaneWorkItemSnapshot } from "./plane-work-item-collector.mjs";

const SCHEMA_VERSION = "tabellio-delivery-evidence-snapshot/v0.1";
const SCHEMA = JSON.parse(readFileSync(new URL("../../schemas/delivery-evidence-snapshot.v0.1.schema.json", import.meta.url), "utf8"));
const DELIVERY_RECORD_ID = /^[^\r\n|#`][^\r\n|#`]{0,127}$/;
const SAFE_REASON = /^[^\r\n]{1,200}$/;

export function joinDeliveryEvidence({ providerSnapshot, planeSnapshot, buildkiteSnapshots = [], releaseSnapshot, deploymentReceipts = [] }) {
  const capturedAt = latestTimestamp([providerSnapshot?.capturedAt, planeSnapshot?.capturedAt, releaseSnapshot?.capturedAt, ...buildkiteSnapshots.map((snapshot) => snapshot?.capturedAt), ...deploymentReceipts.map((receipt) => receipt?.observedAt)]);
  const errors = validateProviderSnapshot(providerSnapshot, providerSnapshot?.repository, capturedAt);
  if (errors.length) throw new Error(`Invalid provider snapshot: ${errors.join("; ")}`);
  if (providerSnapshot.sources.plane?.status !== "available" || providerSnapshot.sources.github?.status !== "available") throw new Error("Delivery evidence requires available Plane and GitHub provider sources.");
  validatePlaneWorkItemSnapshot(planeSnapshot);
  validateGitHubReleaseSnapshot(releaseSnapshot);
  for (const snapshot of buildkiteSnapshots) validateBuildkiteBuildSnapshot(snapshot);
  for (const receipt of deploymentReceipts) validateDeploymentReceipt(receipt);
  if (releaseSnapshot.repository.toLowerCase() !== providerSnapshot.repository.toLowerCase()) throw new Error("Release snapshot repository mismatch.");
  if (buildkiteSnapshots.some((snapshot) => !sameRepository(snapshot.repository, providerSnapshot.repository))) throw new Error("Buildkite snapshot repository mismatch.");
  const projectById = new Map(planeSnapshot.projects.map((project) => [project.id, project.identifier]));
  const stateById = new Map(planeSnapshot.states.map((state) => [state.id, state.group]));
  const itemByKey = new Map(planeSnapshot.workItems.map((item) => [`${projectById.get(item.projectId)}-${item.sequenceNumber}`, item]));
  const records = providerSnapshot.deliveryChanges.map((change) => recordFor(change, { itemByKey, stateById, planeSnapshot, buildkiteSnapshots, releaseSnapshot, deploymentReceipts, repository: providerSnapshot.repository }));
  return validateDeliveryEvidenceSnapshot({
    schemaVersion: SCHEMA_VERSION, repository: providerSnapshot.repository, capturedAt,
    sources: {
      plane: sourceState(planeSnapshot.status, planeSnapshot, `plane:${planeSnapshot.workspace}`),
      buildkite: aggregateBuildkite(buildkiteSnapshots),
      githubRelease: sourceState(releaseSnapshot.status, releaseSnapshot, `github-release:${releaseSnapshot.repository}`),
      deployment: deploymentReceipts.length ? availableSource(deploymentReceipts.map((receipt) => observation(`deployment:${receipt.provider}:${receipt.externalId}`, receipt.observedAt, receipt))) : unavailableSource("No deployment receipts collected."),
    },
    wipByProject: wipByProject(planeSnapshot, capturedAt),
    deliveryRecords: records,
  });
}

export function validateDeliveryEvidenceSnapshot(snapshot) {
  const errors = validateJsonSchema(snapshot, SCHEMA);
  if (errors.length) throw new Error(`Invalid delivery evidence snapshot: ${errors.join("; ")}`);
  if (!isJsonDateTime(snapshot.capturedAt)) throw new Error("Delivery evidence snapshot capturedAt is invalid.");
  if (snapshot.deliveryRecords.some((record) => !DELIVERY_RECORD_ID.test(record.id ?? ""))) throw new Error("Delivery evidence record IDs must be portable single-line identifiers.");
  if (Object.values(snapshot.sources).some((source) => source.reason !== null && !SAFE_REASON.test(source.reason))) throw new Error("Delivery evidence source reasons must be portable single-line text.");
  for (const row of snapshot.wipByProject) if (row.overLimit !== (row.activeItemCount > 3) || row.aging3dCount > row.activeItemCount) throw new Error("Delivery evidence WIP counts conflict.");
  for (const record of snapshot.deliveryRecords) assertRecordEvidence(record);
  return snapshot;
}

function recordFor(change, context) {
  const item = context.itemByKey.get(change.planeStoryId);
  const builds = context.buildkiteSnapshots.flatMap((snapshot) => snapshot.status === "available" ? snapshot.builds.filter((build) => build.commit === change.headCommit).map((build) => ({ ...build, pipeline: snapshot.pipeline })) : []);
  const build = builds.sort((left, right) => Date.parse(right.finishedAt ?? right.createdAt) - Date.parse(left.finishedAt ?? left.createdAt))[0] ?? null;
  const release = context.releaseSnapshot.status === "available" ? context.releaseSnapshot.releases.find((candidate) => candidate.commitStatus === "resolved" && candidate.commit === change.headCommit) ?? null : null;
  const receipt = context.deploymentReceipts.filter((candidate) => candidate.commit === change.headCommit && sameRepository(candidate.repository, context.repository)).sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0] ?? null;
  if (release && change.releasedAt && release.publishedAt !== change.releasedAt) throw new Error(`Conflicting GitHub release timestamp for delivery change ${change.id}.`);
  return {
    id: change.id, linkBasis: change.linkBasis, pullRequestNumber: change.pullRequestNumber, headCommit: change.headCommit,
    plane: item ? { status: "linked", key: change.planeStoryId, stateGroup: context.stateById.get(item.stateId) ?? null, updatedAt: item.updatedAt } : { status: context.planeSnapshot.status === "available" ? "unlinked" : "blocked", key: change.planeStoryId, stateGroup: null, updatedAt: null },
    ci: build ? { status: ciStatus(build.state), pipeline: build.pipeline, buildNumber: build.number, finishedAt: build.finishedAt } : { status: context.buildkiteSnapshots.some((snapshot) => snapshot.status === "blocked") ? "blocked" : "unavailable", pipeline: null, buildNumber: null, finishedAt: null },
    release: release ? { status: "shipped", tagName: release.tagName, publishedAt: release.publishedAt } : { status: context.releaseSnapshot.status === "blocked" ? "blocked" : "unreleased", tagName: null, publishedAt: null },
    deployment: receipt ? { status: receipt.status, provider: receipt.provider, deployedAt: receipt.deployedAt } : { status: "unavailable", provider: null, deployedAt: null },
  };
}

function ciStatus(state) { return state === "passed" ? "passed" : state === "failed" || state === "canceled" || state === "cancelled" ? "failed" : "in_progress"; }
function sourceState(status, snapshot, identity) { return status === "available" ? availableSource([observation(identity, snapshot.capturedAt, snapshot)]) : unavailableSource("Collector unavailable.", "blocked"); }
function aggregateBuildkite(snapshots) {
  if (snapshots.length === 0) return unavailableSource("No Buildkite snapshots collected.");
  if (!snapshots.every((snapshot) => snapshot.status === "available")) return unavailableSource("At least one Buildkite collector was unavailable.", "blocked");
  return availableSource(snapshots.map((snapshot) => observation(`buildkite:${snapshot.organization}/${snapshot.pipeline}`, snapshot.capturedAt, snapshot)));
}
function availableSource(observations) { return { status: "available", reason: null, observations }; }
function unavailableSource(reason, status = "unavailable") { return { status, reason, observations: [] }; }
function observation(id, version, value) { return { id, version, digest: createHash("sha256").update(JSON.stringify(value)).digest("hex") }; }
function latestTimestamp(values) { const valid = values.filter(isJsonDateTime); if (!valid.length) throw new Error("Delivery evidence requires at least one capture timestamp."); return valid.sort((left, right) => Date.parse(right) - Date.parse(left))[0]; }
function wipByProject(snapshot, capturedAt) {
  if (snapshot.status !== "available") return [];
  const states = new Map(snapshot.states.map((state) => [state.id, state.group]));
  const projects = new Map(snapshot.projects.map((project) => [project.id, project.identifier]));
  return [...projects].map(([projectId, project]) => {
    const active = snapshot.workItems.filter((item) => item.projectId === projectId && states.get(item.stateId) === "started");
    const aging3dCount = active.filter((item) => Date.parse(capturedAt) - Date.parse(item.updatedAt) >= 3 * 24 * 60 * 60 * 1000).length;
    return { project, activeItemCount: active.length, aging3dCount, overLimit: active.length > 3 };
  }).sort((left, right) => left.project.localeCompare(right.project));
}
function sameRepository(left, right) { return typeof left === "string" && left.toLowerCase() === String(right ?? "").toLowerCase(); }
function assertRecordEvidence(record) {
  if (record.ci.status === "passed" && (!record.ci.pipeline || !Number.isInteger(record.ci.buildNumber) || !isJsonDateTime(record.ci.finishedAt))) throw new Error("Passed CI evidence requires pipeline, build number, and finishedAt.");
  if (record.release.status === "shipped" && (!record.release.tagName || !isJsonDateTime(record.release.publishedAt))) throw new Error("Shipped release evidence requires tagName and publishedAt.");
  if (record.deployment.status === "passed" && (!record.deployment.provider || !isJsonDateTime(record.deployment.deployedAt))) throw new Error("Passed deployment evidence requires provider and deployedAt.");
}
