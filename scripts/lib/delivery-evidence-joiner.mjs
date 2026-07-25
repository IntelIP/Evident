import { readFileSync } from "node:fs";

import { validateProviderSnapshot } from "./analytics.mjs";
import { validateBuildkiteBuildSnapshot } from "./buildkite-build-collector.mjs";
import { validateDeploymentReceipt } from "./deployment-receipt.mjs";
import { validateGitHubReleaseSnapshot } from "./github-release-collector.mjs";
import { isJsonDateTime, validateJsonSchema } from "./json-schema-validator.mjs";
import { validatePlaneWorkItemSnapshot } from "./plane-work-item-collector.mjs";

const SCHEMA_VERSION = "tabellio-delivery-evidence-snapshot/v0.1";
const SCHEMA = JSON.parse(readFileSync(new URL("../../schemas/delivery-evidence-snapshot.v0.1.schema.json", import.meta.url), "utf8"));
const DELIVERY_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function joinDeliveryEvidence({ providerSnapshot, planeSnapshot, buildkiteSnapshots = [], releaseSnapshot, deploymentReceipts = [] }) {
  const capturedAt = latestTimestamp([providerSnapshot?.capturedAt, planeSnapshot?.capturedAt, releaseSnapshot?.capturedAt, ...buildkiteSnapshots.map((snapshot) => snapshot?.capturedAt), ...deploymentReceipts.map((receipt) => receipt?.observedAt)]);
  const errors = validateProviderSnapshot(providerSnapshot, providerSnapshot?.repository, capturedAt);
  if (errors.length) throw new Error(`Invalid provider snapshot: ${errors.join("; ")}`);
  validatePlaneWorkItemSnapshot(planeSnapshot);
  validateGitHubReleaseSnapshot(releaseSnapshot);
  for (const snapshot of buildkiteSnapshots) validateBuildkiteBuildSnapshot(snapshot);
  for (const receipt of deploymentReceipts) validateDeploymentReceipt(receipt);
  if (releaseSnapshot.repository.toLowerCase() !== providerSnapshot.repository.toLowerCase()) throw new Error("Release snapshot repository mismatch.");
  const projectById = new Map(planeSnapshot.projects.map((project) => [project.id, project.identifier]));
  const stateById = new Map(planeSnapshot.states.map((state) => [state.id, state.group]));
  const itemByKey = new Map(planeSnapshot.workItems.map((item) => [`${projectById.get(item.projectId)}-${item.sequenceNumber}`, item]));
  const records = providerSnapshot.deliveryChanges.map((change) => recordFor(change, { itemByKey, stateById, planeSnapshot, buildkiteSnapshots, releaseSnapshot, deploymentReceipts }));
  return validateDeliveryEvidenceSnapshot({
    schemaVersion: SCHEMA_VERSION, repository: providerSnapshot.repository, capturedAt,
    sources: { plane: sourceState(planeSnapshot.status), buildkite: aggregateBuildkite(buildkiteSnapshots), githubRelease: sourceState(releaseSnapshot.status), deployment: deploymentReceipts.length ? { status: "available", reason: null } : { status: "unavailable", reason: "No deployment receipts collected." } },
    wipByProject: wipByProject(planeSnapshot, capturedAt),
    deliveryRecords: records,
  });
}

export function validateDeliveryEvidenceSnapshot(snapshot) {
  const errors = validateJsonSchema(snapshot, SCHEMA);
  if (errors.length) throw new Error(`Invalid delivery evidence snapshot: ${errors.join("; ")}`);
  if (!isJsonDateTime(snapshot.capturedAt)) throw new Error("Delivery evidence snapshot capturedAt is invalid.");
  if (snapshot.deliveryRecords.some((record) => !DELIVERY_RECORD_ID.test(record.id ?? ""))) throw new Error("Delivery evidence record IDs must be portable single-line identifiers.");
  return snapshot;
}

function recordFor(change, context) {
  const item = context.itemByKey.get(change.planeStoryId);
  const builds = context.buildkiteSnapshots.flatMap((snapshot) => snapshot.status === "available" ? snapshot.builds.filter((build) => build.commit === change.headCommit).map((build) => ({ ...build, pipeline: snapshot.pipeline })) : []);
  const build = builds.sort((left, right) => right.number - left.number)[0] ?? null;
  const release = context.releaseSnapshot.status === "available" ? context.releaseSnapshot.releases.find((candidate) => candidate.commitStatus === "resolved" && candidate.commit === change.headCommit) ?? null : null;
  const receipt = context.deploymentReceipts.filter((candidate) => candidate.commit === change.headCommit).sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0] ?? null;
  return {
    id: change.id, linkBasis: change.linkBasis, pullRequestNumber: change.pullRequestNumber, headCommit: change.headCommit,
    plane: item ? { status: "linked", key: change.planeStoryId, stateGroup: context.stateById.get(item.stateId) ?? null, updatedAt: item.updatedAt } : { status: context.planeSnapshot.status === "available" ? "unlinked" : "blocked", key: change.planeStoryId, stateGroup: null, updatedAt: null },
    ci: build ? { status: ciStatus(build.state), pipeline: build.pipeline, buildNumber: build.number, finishedAt: build.finishedAt } : { status: context.buildkiteSnapshots.some((snapshot) => snapshot.status === "blocked") ? "blocked" : "unavailable", pipeline: null, buildNumber: null, finishedAt: null },
    release: release ? { status: "shipped", tagName: release.tagName, publishedAt: release.publishedAt } : { status: context.releaseSnapshot.status === "blocked" ? "blocked" : "unreleased", tagName: null, publishedAt: null },
    deployment: receipt ? { status: receipt.status, provider: receipt.provider, deployedAt: receipt.deployedAt } : { status: "unavailable", provider: null, deployedAt: null },
  };
}

function ciStatus(state) { return state === "passed" ? "passed" : state === "failed" || state === "canceled" || state === "cancelled" ? "failed" : "in_progress"; }
function sourceState(status) { return status === "available" ? { status: "available", reason: null } : { status: "blocked", reason: "Collector unavailable." }; }
function aggregateBuildkite(snapshots) { return snapshots.length === 0 ? { status: "unavailable", reason: "No Buildkite snapshots collected." } : snapshots.every((snapshot) => snapshot.status === "available") ? { status: "available", reason: null } : { status: "blocked", reason: "At least one Buildkite collector was unavailable." }; }
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
