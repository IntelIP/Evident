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

export function joinDeliveryEvidence({ providerSnapshot, planeSnapshot, buildkiteSnapshots = [], releaseSnapshot, deploymentReceipts = [], deploymentBlockedReason = null, deploymentEnvironment = null }) {
  const capturedAt = latestTimestamp([providerSnapshot?.capturedAt, planeSnapshot?.capturedAt, releaseSnapshot?.capturedAt, ...buildkiteSnapshots.map((snapshot) => snapshot?.capturedAt), ...deploymentReceipts.map((receipt) => receipt?.observedAt)]);
  validateJoinSnapshots({ providerSnapshot, planeSnapshot, buildkiteSnapshots, releaseSnapshot, deploymentReceipts, capturedAt });
  assertJoinBindings({ providerSnapshot, planeSnapshot, buildkiteSnapshots, releaseSnapshot, deploymentReceipts, deploymentBlockedReason, deploymentEnvironment });
  const targetReceipts = deploymentReceipts.filter((receipt) => receipt.environment === deploymentEnvironment);
  const context = recordContext({ providerSnapshot, planeSnapshot, buildkiteSnapshots, releaseSnapshot, targetReceipts, deploymentBlockedReason, deploymentEnvironment });
  const records = providerSnapshot.deliveryChanges.map((change) => recordFor(change, context));
  return validateDeliveryEvidenceSnapshot({
    schemaVersion: SCHEMA_VERSION, repository: providerSnapshot.repository, capturedAt,
    sources: {
      provider: availableSource([observation(`provider:${providerSnapshot.repository}`, providerSnapshot.capturedAt, providerSnapshot)]),
      plane: sourceState(planeSnapshot.status, planeSnapshot, `plane:${planeSnapshot.workspace}`),
      buildkite: aggregateBuildkite(buildkiteSnapshots),
      githubRelease: sourceState(releaseSnapshot.status, releaseSnapshot, `github-release:${releaseSnapshot.repository}`, releaseSnapshot.releases.map(releaseClaim)),
      deployment: deploymentSource(targetReceipts, deploymentBlockedReason, deploymentEnvironment),
    },
    wipByProject: wipByProject(planeSnapshot, planeSnapshot.capturedAt),
    deliveryRecords: records,
  });
}

function validateJoinSnapshots({ providerSnapshot, planeSnapshot, buildkiteSnapshots, releaseSnapshot, deploymentReceipts, capturedAt }) {
  const errors = validateProviderSnapshot(providerSnapshot, providerSnapshot?.repository, capturedAt);
  if (errors.length) throw new Error(`Invalid provider snapshot: ${errors.join("; ")}`);
  if (providerSnapshot.sources.plane?.status !== "available" || providerSnapshot.sources.github?.status !== "available") throw new Error("Delivery evidence requires available Plane and GitHub provider sources.");
  validatePlaneWorkItemSnapshot(planeSnapshot);
  validateGitHubReleaseSnapshot(releaseSnapshot);
  for (const snapshot of buildkiteSnapshots) validateBuildkiteBuildSnapshot(snapshot);
  for (const receipt of deploymentReceipts) validateDeploymentReceipt(receipt);
}

function assertJoinBindings({ providerSnapshot, planeSnapshot, buildkiteSnapshots, releaseSnapshot, deploymentReceipts, deploymentBlockedReason, deploymentEnvironment }) {
  if (buildkiteSnapshots.length > 1) throw new Error("Delivery evidence requires one designated Buildkite pipeline snapshot.");
  if (releaseSnapshot.repository.toLowerCase() !== providerSnapshot.repository.toLowerCase()) throw new Error("Release snapshot repository mismatch.");
  if (buildkiteSnapshots.some((snapshot) => !sameRepository(snapshot.repository, providerSnapshot.repository))) throw new Error("Buildkite snapshot repository mismatch.");
  if (deploymentReceipts.some((receipt) => !sameRepository(receipt.repository, providerSnapshot.repository))) throw new Error("Deployment receipt repository mismatch.");
  if (providerSnapshot.sources.plane.workspace !== planeSnapshot.workspace) throw new Error("Provider and Plane snapshot workspace mismatch.");
  if (deploymentEnvironment !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(deploymentEnvironment)) throw new Error("Deployment environment is invalid.");
  if ((deploymentReceipts.length || deploymentBlockedReason) && deploymentEnvironment === null) throw new Error("Deployment evidence requires a designated target environment.");
}

function recordContext({ providerSnapshot, planeSnapshot, buildkiteSnapshots, releaseSnapshot, targetReceipts, deploymentBlockedReason, deploymentEnvironment }) {
  const projectById = new Map(planeSnapshot.projects.map((project) => [project.id, project.identifier]));
  const stateById = new Map(planeSnapshot.states.map((state) => [state.id, state.group]));
  const itemByKey = new Map(planeSnapshot.workItems.map((item) => [`${projectById.get(item.projectId)}-${item.sequenceNumber}`, item]));
  return { itemByKey, stateById, planeSnapshot, buildkiteSnapshots, releaseSnapshot, deploymentReceipts: targetReceipts, deploymentBlockedReason, deploymentEnvironment, repository: providerSnapshot.repository };
}

function deploymentSource(receipts, blockedReason, environment) {
  if (receipts.length) return availableSource(receipts.map(deploymentObservation));
  return unavailableSource(blockedReason ?? `No ${environment ?? "target"} deployment receipts collected.`, blockedReason ? "blocked" : "unavailable");
}

function deploymentObservation(receipt) {
  return observation(`deployment:${receipt.provider}:${receipt.externalId}`, receipt.observedAt, receipt, [deploymentClaim(receipt)]);
}

export function validateDeliveryEvidenceSnapshot(snapshot) {
  const errors = validateJsonSchema(snapshot, SCHEMA);
  if (errors.length) throw new Error(`Invalid delivery evidence snapshot: ${errors.join("; ")}`);
  if (!isJsonDateTime(snapshot.capturedAt)) throw new Error("Delivery evidence snapshot capturedAt is invalid.");
  if (snapshot.deliveryRecords.some((record) => !DELIVERY_RECORD_ID.test(record.id ?? ""))) throw new Error("Delivery evidence record IDs must be portable single-line identifiers.");
  if (new Set(snapshot.deliveryRecords.map((record) => record.id)).size !== snapshot.deliveryRecords.length) throw new Error("Delivery evidence record IDs must be unique.");
  if (new Set(snapshot.wipByProject.map((row) => row.project)).size !== snapshot.wipByProject.length) throw new Error("Delivery evidence WIP projects must be unique.");
  if (Object.values(snapshot.sources).some((source) => source.reason !== null && !SAFE_REASON.test(source.reason))) throw new Error("Delivery evidence source reasons must be portable single-line text.");
  for (const [name, source] of Object.entries(snapshot.sources)) assertSourceState(name, source, snapshot.capturedAt);
  for (const row of snapshot.wipByProject) if (row.overLimit !== (row.activeItemCount > 3) || row.aging3dCount > row.activeItemCount) throw new Error("Delivery evidence WIP counts conflict.");
  for (const record of snapshot.deliveryRecords) assertRecordEvidence(record, snapshot.sources, snapshot.capturedAt);
  return snapshot;
}

function recordFor(change, context) {
  const build = latestBuildFor(change.headCommit, context.buildkiteSnapshots);
  const release = releaseFor(change, context.releaseSnapshot);
  const receipt = latestReceiptFor(change, context.deploymentReceipts, context.repository);
  if (release && change.releasedAt && release.publishedAt !== change.releasedAt) throw new Error(`Conflicting GitHub release timestamp for delivery change ${change.id}.`);
  return {
    id: change.id, linkBasis: change.linkBasis, pullRequestNumber: change.pullRequestNumber, headCommit: change.headCommit, mergeCommit: change.mergeCommit ?? null,
    plane: planeEvidenceFor(change, context),
    ci: build ? { status: ciStatus(build.state), pipeline: build.pipeline, buildNumber: build.number, finishedAt: build.finishedAt } : { status: context.buildkiteSnapshots.some((snapshot) => snapshot.status === "blocked") ? "blocked" : "unavailable", pipeline: null, buildNumber: null, finishedAt: null },
    release: release
      ? { status: "shipped", releaseId: release.id, tagName: release.tagName, publishedAt: release.publishedAt, commit: release.commit, sourceClaimDigest: digestClaim(releaseClaim(release)) }
      : { status: context.releaseSnapshot.status === "blocked" ? "blocked" : "unreleased", releaseId: null, tagName: null, publishedAt: null, commit: null, sourceClaimDigest: null },
    deployment: receipt
      ? { status: receipt.status, environment: receipt.environment, provider: receipt.provider, deployedAt: receipt.deployedAt }
      : { status: context.deploymentBlockedReason ? "blocked" : "unavailable", environment: context.deploymentEnvironment, provider: null, deployedAt: null },
  };
}

function planeEvidenceFor(change, context) {
  const item = context.itemByKey.get(change.planeStoryId);
  if (item?.createdAt === change.storyCreatedAt) {
    return { status: "linked", key: change.planeStoryId, stateGroup: context.stateById.get(item.stateId) ?? null, updatedAt: item.updatedAt };
  }
  return { status: context.planeSnapshot.status === "available" ? "unlinked" : "blocked", key: change.planeStoryId, stateGroup: null, updatedAt: null };
}

function latestBuildFor(commit, snapshots) {
  const builds = snapshots.flatMap((snapshot) => snapshot.status === "available" ? snapshot.builds.filter((build) => build.commit === commit).map((build) => ({ ...build, pipeline: snapshot.pipeline })) : []);
  return latestBy(builds, (build) => build.finishedAt ?? build.createdAt);
}

function releaseFor(change, snapshot) {
  if (snapshot.status !== "available") return null;
  return snapshot.releases
    .filter((candidate) => releaseMatches(change, candidate))
    .sort((left, right) => Date.parse(left.publishedAt) - Date.parse(right.publishedAt))[0] ?? null;
}

function releaseMatches(change, candidate) {
  if (candidate.commitStatus !== "resolved") return false;
  if (change.releaseCommit ? candidate.commit !== change.releaseCommit : !changeCommits(change).includes(candidate.commit)) return false;
  if (change.releasedAt && candidate.publishedAt !== change.releasedAt) return false;
  return !change.mergedAt || Date.parse(candidate.publishedAt) >= Date.parse(change.mergedAt);
}

function latestReceiptFor(change, receipts, repository) {
  const commits = changeCommits(change);
  return latestBy(receipts.filter((receipt) => commits.includes(receipt.commit) && sameRepository(receipt.repository, repository)), (receipt) => receipt.observedAt);
}

function changeCommits(change) {
  return [change.mergeCommit, change.headCommit].filter(Boolean);
}

function latestBy(values, timestampFor) {
  return values.sort((left, right) => Date.parse(timestampFor(right)) - Date.parse(timestampFor(left)))[0] ?? null;
}

function ciStatus(state) {
  if (state === "passed") return "passed";
  if (["failed", "canceled", "cancelled"].includes(state)) return "failed";
  if (["scheduled", "running", "canceling", "cancelling"].includes(state)) return "in_progress";
  return "blocked";
}
function sourceState(status, snapshot, identity, claims = []) { return status === "available" ? availableSource([observation(identity, snapshot.capturedAt, snapshot, claims)]) : unavailableSource("Collector unavailable.", "blocked"); }
function aggregateBuildkite(snapshots) {
  if (snapshots.length === 0) return unavailableSource("No Buildkite snapshots collected.");
  if (!snapshots.every((snapshot) => snapshot.status === "available")) return unavailableSource("At least one Buildkite collector was unavailable.", "blocked");
  return availableSource(snapshots.map((snapshot) => observation(`buildkite:${snapshot.organization}/${snapshot.pipeline}`, snapshot.capturedAt, snapshot)));
}
function availableSource(observations) { return { status: "available", reason: null, observations }; }
function unavailableSource(reason, status = "unavailable") { return { status, reason, observations: [] }; }
function observation(id, version, value, claims = []) { return { id, version, digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"), claimDigests: [...new Set(claims.map(digestClaim))] }; }
function digestClaim(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function releaseClaim(release) { return { id: release.id, tagName: release.tagName, publishedAt: release.publishedAt, commit: release.commit, commitStatus: release.commitStatus }; }
function deploymentClaim(receipt) { return { id: receipt.id, repository: receipt.repository, environment: receipt.environment, commit: receipt.commit, status: receipt.status, deployedAt: receipt.deployedAt, observedAt: receipt.observedAt, provider: receipt.provider, externalId: receipt.externalId }; }
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
function assertSourceState(name, source, capturedAt) {
  if (source.status === "available" && (source.reason !== null || source.observations.length === 0)) {
    throw new Error(`Available ${name} source requires observations and no reason.`);
  }
  if (source.status !== "available" && (!source.reason || source.observations.length !== 0)) {
    throw new Error(`Unavailable ${name} source requires a reason and no observations.`);
  }
  if (source.observations.some((item) => isJsonDateTime(item.version) && Date.parse(item.version) > Date.parse(capturedAt))) {
    throw new Error(`${name} source observation cannot be newer than the delivery snapshot.`);
  }
}
function assertRecordEvidence(record, sources, capturedAt) {
  assertPlaneEvidence(record.plane, sources.plane, capturedAt);
  assertCiEvidence(record.ci, sources.buildkite, capturedAt);
  assertReleaseEvidence(record.release, sources.githubRelease, capturedAt);
  assertDeploymentEvidence(record.deployment, sources.deployment, capturedAt);
}
function assertPlaneEvidence(plane, source, capturedAt) {
  if (plane.status !== "linked") return;
  if (!plane.key || !plane.stateGroup || !isJsonDateTime(plane.updatedAt)) throw new Error("Linked Plane evidence requires key, stateGroup, and updatedAt.");
  if (source.status !== "available") throw new Error("Linked Plane evidence requires an available Plane source observation.");
  assertEventNotAfterCapture(plane.updatedAt, capturedAt, "Plane");
}
function assertCiEvidence(ci, source, capturedAt) {
  if (ci.status !== "passed" && ci.status !== "failed") return;
  if (!ci.pipeline || !Number.isInteger(ci.buildNumber) || !isJsonDateTime(ci.finishedAt)) throw new Error("Decisive CI evidence requires pipeline, build number, and finishedAt.");
  if (source.status !== "available") throw new Error("Decisive CI evidence requires an available Buildkite source observation.");
  assertEventNotAfterCapture(ci.finishedAt, capturedAt, "CI");
}
function assertReleaseEvidence(release, source, capturedAt) {
  if (release.status !== "shipped") return;
  if (!release.releaseId || !release.tagName || !isJsonDateTime(release.publishedAt) || !release.commit || !release.sourceClaimDigest) throw new Error("Shipped release evidence requires exact release fields.");
  if (source.status !== "available") throw new Error("Shipped release evidence requires an available GitHub Release source observation.");
  const expected = digestClaim(releaseClaim({ id: release.releaseId, tagName: release.tagName, publishedAt: release.publishedAt, commit: release.commit, commitStatus: "resolved" }));
  if (release.sourceClaimDigest !== expected || !source.observations.some((item) => item.claimDigests.includes(expected))) {
    throw new Error("Shipped release evidence is not bound to the GitHub Release observation.");
  }
  assertEventNotAfterCapture(release.publishedAt, capturedAt, "Release");
}
function assertDeploymentEvidence(deployment, source, capturedAt) {
  if (deployment.status !== "passed") return;
  if (!deployment.environment || !deployment.provider || !isJsonDateTime(deployment.deployedAt)) throw new Error("Passed deployment evidence requires environment, provider, and deployedAt.");
  if (source.status !== "available") throw new Error("Passed deployment evidence requires an available deployment source observation.");
  assertEventNotAfterCapture(deployment.deployedAt, capturedAt, "Deployment");
}
function assertEventNotAfterCapture(value, capturedAt, label) {
  if (Date.parse(value) > Date.parse(capturedAt)) throw new Error(`${label} evidence cannot be newer than the delivery snapshot.`);
}
