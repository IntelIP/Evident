import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { validateBuildkiteBuildSnapshot } from "./buildkite-build-collector.mjs";
import { validateDeploymentReceipt } from "./deployment-receipt.mjs";
import { validateGitHubReleaseSnapshot } from "./github-release-collector.mjs";
import { isJsonDateTime, validateJsonSchema } from "./json-schema-validator.mjs";
import { validatePlaneWorkItemSnapshot } from "./plane-work-item-collector.mjs";
import {
  isPortableIdentifier,
  isSafeProviderText,
  validateProviderSnapshot,
} from "./portable-evidence.mjs";

const SCHEMA_VERSION = "tabellio-delivery-evidence-snapshot/v0.1";
const SCHEMA = JSON.parse(readFileSync(
  new URL("../../schemas/delivery-evidence-snapshot.v0.1.schema.json", import.meta.url),
  "utf8",
));
const DELIVERY_RECORD_ID = /^[^\r\n|#`][^\r\n|#`]{0,127}$/;
const SAFE_REASON = /^[^\r\n]{1,200}$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function joinDeliveryEvidence({
  providerSnapshot,
  planeSnapshot,
  buildkiteSnapshots = [],
  releaseSnapshot,
  deploymentReceipts = [],
  deploymentBlockedReason = null,
  deploymentEnvironment = null,
}) {
  const capturedAt = latestTimestamp([
    providerSnapshot?.capturedAt,
    planeSnapshot?.capturedAt,
    releaseSnapshot?.capturedAt,
    ...buildkiteSnapshots.map((snapshot) => snapshot?.capturedAt),
    ...deploymentReceipts.map((receipt) => receipt?.observedAt),
  ]);
  validateJoinSnapshots({
    providerSnapshot,
    planeSnapshot,
    buildkiteSnapshots,
    releaseSnapshot,
    deploymentReceipts,
    capturedAt,
  });
  assertJoinBindings({
    providerSnapshot,
    planeSnapshot,
    buildkiteSnapshots,
    releaseSnapshot,
    deploymentReceipts,
    deploymentBlockedReason,
    deploymentEnvironment,
  });
  const targetReceipts = deploymentReceipts.filter(
    (receipt) => receipt.environment === deploymentEnvironment,
  );
  const context = recordContext({
    providerSnapshot,
    planeSnapshot,
    buildkiteSnapshots,
    releaseSnapshot,
    targetReceipts,
    deploymentBlockedReason,
    deploymentEnvironment,
  });
  return validateDeliveryEvidenceSnapshot({
    schemaVersion: SCHEMA_VERSION,
    repository: providerSnapshot.repository,
    capturedAt,
    sources: {
      provider: availableSource([
        observation(
          boundedObservationId("provider", providerSnapshot.repository),
          providerSnapshot.capturedAt,
          providerSnapshot,
          providerSnapshot.deliveryChanges.map(providerChangeClaim),
        ),
      ]),
      plane: sourceState(
        planeSnapshot.status,
        planeSnapshot,
        boundedObservationId("plane", planeSnapshot.workspace),
        planeClaims(planeSnapshot),
      ),
      buildkite: aggregateBuildkite(buildkiteSnapshots),
      githubRelease: sourceState(
        releaseSnapshot.status,
        releaseSnapshot,
        boundedObservationId("github-release", releaseSnapshot.repository),
        releaseSnapshot.releases.map(releaseClaim),
      ),
      deployment: deploymentSource(
        targetReceipts,
        deploymentBlockedReason,
        deploymentEnvironment,
      ),
    },
    wipByProject: wipByProject(planeSnapshot, planeSnapshot.capturedAt),
    deliveryRecords: providerSnapshot.deliveryChanges.map(
      (change) => recordFor(change, context),
    ),
  });
}

export function validateDeliveryEvidenceSnapshot(snapshot) {
  const errors = validateJsonSchema(snapshot, SCHEMA);
  if (errors.length) {
    throw new Error(`Invalid delivery evidence snapshot: ${errors.join("; ")}`);
  }
  if (!isJsonDateTime(snapshot.capturedAt)) {
    throw new Error("Delivery evidence snapshot capturedAt is invalid.");
  }
  assertUniquePortableRecords(snapshot);
  assertSafeSources(snapshot);
  assertWipRows(snapshot.wipByProject);
  for (const record of snapshot.deliveryRecords) {
    assertRecordEvidence(record, snapshot);
  }
  return snapshot;
}

function validateJoinSnapshots({
  providerSnapshot,
  planeSnapshot,
  buildkiteSnapshots,
  releaseSnapshot,
  deploymentReceipts,
  capturedAt,
}) {
  assertProviderSnapshot(providerSnapshot, capturedAt);
  validatePlaneWorkItemSnapshot(planeSnapshot);
  validateGitHubReleaseSnapshot(releaseSnapshot);
  buildkiteSnapshots.forEach(validateBuildkiteBuildSnapshot);
  deploymentReceipts.forEach(validateDeploymentReceipt);
}

function assertProviderSnapshot(providerSnapshot, capturedAt) {
  const errors = validateProviderSnapshot(providerSnapshot, {
    repository: providerSnapshot?.repository,
    headCommit: providerSnapshot?.headCommit,
    observedAt: capturedAt,
  });
  if (errors.length) throw new Error(`Invalid provider snapshot: ${errors.join("; ")}`);
  ensure(
    providerSnapshot.sources.plane.status === "available",
    "Delivery evidence requires available Plane provider source.",
  );
  ensure(
    providerSnapshot.sources.github.status === "available",
    "Delivery evidence requires available GitHub provider source.",
  );
}

function assertJoinBindings(input) {
  const {
    providerSnapshot,
    planeSnapshot,
    buildkiteSnapshots,
    releaseSnapshot,
    deploymentReceipts,
    deploymentBlockedReason,
    deploymentEnvironment,
  } = input;
  ensure(
    buildkiteSnapshots.length <= 1,
    "Delivery evidence requires one designated Buildkite pipeline snapshot.",
  );
  ensure(
    sameRepository(releaseSnapshot.repository, providerSnapshot.repository),
    "Release snapshot repository mismatch.",
  );
  ensure(
    buildkiteSnapshots.every(
      (snapshot) => sameRepository(snapshot.repository, providerSnapshot.repository),
    ),
    "Buildkite snapshot repository mismatch.",
  );
  ensure(
    deploymentReceipts.every(
      (receipt) => sameRepository(receipt.repository, providerSnapshot.repository),
    ),
    "Deployment receipt repository mismatch.",
  );
  ensure(
    isPortableIdentifier(providerSnapshot.sources.plane.workspace),
    "Provider Plane workspace is invalid.",
  );
  ensure(
    providerSnapshot.sources.plane.workspace === planeSnapshot.workspace,
    "Provider and Plane snapshot workspace mismatch.",
  );
  if (deploymentEnvironment !== null) {
    ensure(
      ENVIRONMENT.test(deploymentEnvironment),
      "Deployment environment is invalid.",
    );
  }
  ensure(
    !(deploymentReceipts.length || deploymentBlockedReason)
      || deploymentEnvironment !== null,
    "Deployment evidence requires a designated target environment.",
  );
}

function recordContext(input) {
  const {
    providerSnapshot,
    planeSnapshot,
    buildkiteSnapshots,
    releaseSnapshot,
    targetReceipts,
    deploymentBlockedReason,
    deploymentEnvironment,
  } = input;
  const projectById = new Map(
    planeSnapshot.projects.map((project) => [project.id, project.identifier]),
  );
  const stateById = new Map(
    planeSnapshot.states.map((state) => [state.id, state.group]),
  );
  const itemByKey = new Map(planeSnapshot.workItems.map((item) => [
    `${projectById.get(item.projectId)}-${item.sequenceNumber}`,
    item,
  ]));
  return {
    itemByKey,
    stateById,
    planeSnapshot,
    buildkiteSnapshots,
    releaseSnapshot,
    deploymentReceipts: targetReceipts,
    deploymentBlockedReason,
    deploymentEnvironment,
    repository: providerSnapshot.repository,
  };
}

function recordFor(change, context) {
  const build = latestBuildFor(change.headCommit, context.buildkiteSnapshots);
  const release = releaseFor(change, context.releaseSnapshot);
  const receipt = latestReceiptFor(
    change,
    context.deploymentReceipts,
    context.repository,
  );
  assertReleaseTimestamp(change, release);
  return {
    id: change.id,
    linkBasis: change.linkBasis,
    pullRequestNumber: change.pullRequestNumber,
    headCommit: change.headCommit,
    mergeCommit: change.mergeCommit || null,
    sourceClaimDigest: digestClaim(providerChangeClaim(change)),
    plane: planeEvidenceFor(change, context),
    ci: ciEvidenceFor(build, context.buildkiteSnapshots),
    release: releaseEvidenceFor(release, context.releaseSnapshot),
    deployment: deploymentEvidenceFor(receipt, context),
  };
}

function assertReleaseTimestamp(change, release) {
  if (!release) return;
  if (!change.releasedAt) return;
  ensure(
    release.publishedAt === change.releasedAt,
    `Conflicting GitHub release timestamp for delivery change ${change.id}.`,
  );
}

function planeEvidenceFor(change, context) {
  const item = context.itemByKey.get(change.planeStoryId);
  if (planeItemMatches(item, change)) {
    return linkedPlaneEvidence(
      change,
      item,
      context.stateById,
      context.planeSnapshot.workspace,
    );
  }
  return {
    status: missingPlaneStatus(context.planeSnapshot),
    workspace: context.planeSnapshot.workspace,
    key: change.planeStoryId,
    createdAt: null,
    stateGroup: null,
    updatedAt: null,
    sourceClaimDigest: null,
  };
}

function planeItemMatches(item, change) {
  if (!item) return false;
  return item.createdAt === change.storyCreatedAt;
}

function linkedPlaneEvidence(change, item, stateById, workspace) {
  const stateGroup = stateById.get(item.stateId) || null;
  return {
    status: "linked",
    workspace,
    key: change.planeStoryId,
    createdAt: item.createdAt,
    stateGroup,
    updatedAt: item.updatedAt,
    sourceClaimDigest: digestClaim(
      planeClaim(workspace, change.planeStoryId, item, stateGroup),
    ),
  };
}

function missingPlaneStatus(snapshot) {
  return snapshot.status === "available" ? "unlinked" : "blocked";
}

function ciEvidenceFor(build, snapshots) {
  if (!build) {
    return {
      status: snapshots.some((snapshot) => snapshot.status === "blocked")
        ? "blocked"
        : "unavailable",
      pipeline: null,
      buildNumber: null,
      finishedAt: null,
      sourceClaimDigest: null,
    };
  }
  const claim = buildClaim(build);
  return {
    status: ciStatus(build.state),
    pipeline: build.pipeline,
    buildNumber: build.number,
    finishedAt: build.finishedAt,
    sourceClaimDigest: digestClaim(claim),
  };
}

function releaseEvidenceFor(release, snapshot) {
  if (!release) {
    return {
      status: snapshot.status === "blocked" ? "blocked" : "unreleased",
      releaseId: null,
      tagName: null,
      publishedAt: null,
      commit: null,
      sourceClaimDigest: null,
    };
  }
  return {
    status: "shipped",
    releaseId: release.id,
    tagName: release.tagName,
    publishedAt: release.publishedAt,
    commit: release.commit,
    sourceClaimDigest: digestClaim(releaseClaim(release)),
  };
}

function deploymentEvidenceFor(receipt, context) {
  if (!receipt) {
    return {
      status: context.deploymentBlockedReason ? "blocked" : "unavailable",
      receiptId: null,
      environment: context.deploymentEnvironment,
      provider: null,
      commit: null,
      deployedAt: null,
      observedAt: null,
      sourceClaimDigest: null,
    };
  }
  return {
    status: receipt.status,
    receiptId: receipt.id,
    environment: receipt.environment,
    provider: receipt.provider,
    commit: receipt.commit,
    deployedAt: receipt.deployedAt,
    observedAt: receipt.observedAt,
    sourceClaimDigest: digestClaim(deploymentClaim(receipt)),
  };
}

function latestBuildFor(commit, snapshots) {
  const builds = snapshots.flatMap((snapshot) => {
    if (snapshot.status !== "available") return [];
    return snapshot.builds
      .filter((build) => build.commit === commit)
      .map((build) => ({ ...build, pipeline: snapshot.pipeline }));
  });
  return latestBy(builds, (build) => build.finishedAt ?? build.createdAt);
}

function releaseFor(change, snapshot) {
  if (snapshot.status !== "available") return null;
  return snapshot.releases
    .filter((candidate) => releaseMatches(change, candidate))
    .sort(
      (left, right) => Date.parse(left.publishedAt) - Date.parse(right.publishedAt),
    )[0] ?? null;
}

function releaseMatches(change, candidate) {
  return candidate.commitStatus === "resolved"
    && releaseCommitMatches(change, candidate)
    && releaseTimestampMatches(change, candidate)
    && releaseFollowsMerge(change, candidate);
}

function releaseCommitMatches(change, candidate) {
  if (change.releaseCommit) return candidate.commit === change.releaseCommit;
  return changeCommits(change).includes(candidate.commit);
}

function releaseTimestampMatches(change, candidate) {
  if (!change.releasedAt) return true;
  return candidate.publishedAt === change.releasedAt;
}

function releaseFollowsMerge(change, candidate) {
  if (!change.mergedAt) return true;
  return Date.parse(candidate.publishedAt) >= Date.parse(change.mergedAt);
}

function latestReceiptFor(change, receipts, repository) {
  const commits = changeCommits(change);
  return latestBy(
    receipts.filter(
      (receipt) =>
        commits.includes(receipt.commit)
        && sameRepository(receipt.repository, repository),
    ),
    (receipt) => receipt.observedAt,
  );
}

function changeCommits(change) {
  return [change.mergeCommit, change.headCommit].filter(Boolean);
}

function deploymentSource(receipts, blockedReason, environment) {
  if (receipts.length) {
    return availableSource(receipts.map(deploymentObservation));
  }
  return unavailableSource(
    deploymentUnavailableReason(blockedReason, environment),
    deploymentUnavailableStatus(blockedReason),
  );
}

function deploymentUnavailableReason(blockedReason, environment) {
  if (blockedReason) return blockedReason;
  return `No ${environment || "target"} deployment receipts collected.`;
}

function deploymentUnavailableStatus(blockedReason) {
  return blockedReason ? "blocked" : "unavailable";
}

function deploymentObservation(receipt) {
  return observation(
    boundedObservationId(`deployment:${receipt.provider}`, receipt.id),
    receipt.observedAt,
    receipt,
    [deploymentClaim(receipt)],
  );
}

function aggregateBuildkite(snapshots) {
  if (snapshots.length === 0) {
    return unavailableSource("No Buildkite snapshots collected.");
  }
  if (!snapshots.every((snapshot) => snapshot.status === "available")) {
    return unavailableSource(
      "At least one Buildkite collector was unavailable.",
      "blocked",
    );
  }
  return availableSource(snapshots.map((snapshot) => observation(
    boundedObservationId(
      "buildkite",
      `${snapshot.organization}/${snapshot.pipeline}`,
    ),
    snapshot.capturedAt,
    snapshot,
    snapshot.builds.map((build) => buildClaim({
      ...build,
      pipeline: snapshot.pipeline,
    })),
  )));
}

function sourceState(status, snapshot, identity, claims = []) {
  return status === "available"
    ? availableSource([observation(identity, snapshot.capturedAt, snapshot, claims)])
    : unavailableSource("Collector unavailable.", "blocked");
}

function observation(id, version, value, claims = []) {
  return {
    id,
    version,
    digest: digestClaim(value),
    claimDigests: [...new Set(claims.map(digestClaim))],
  };
}

function boundedObservationId(prefix, identity) {
  const candidate = `${prefix}:${identity}`;
  if (candidate.length <= 192) return candidate;
  return `${prefix}:sha256-${digestClaim(candidate).slice(0, 32)}`;
}

function buildClaim(build) {
  return {
    pipeline: build.pipeline,
    buildNumber: build.number,
    commit: build.commit,
    status: ciStatus(build.state),
    finishedAt: build.finishedAt,
  };
}

function providerChangeClaim(change) {
  return {
    id: change.id,
    linkBasis: change.linkBasis,
    pullRequestNumber: change.pullRequestNumber,
    headCommit: change.headCommit,
    mergeCommit: change.mergeCommit || null,
    planeStoryId: change.planeStoryId,
  };
}

function planeClaims(snapshot) {
  const projects = new Map(
    snapshot.projects.map((project) => [project.id, project.identifier]),
  );
  const states = new Map(
    snapshot.states.map((state) => [state.id, state.group]),
  );
  return snapshot.workItems.map((item) => planeClaim(
    snapshot.workspace,
    `${projects.get(item.projectId)}-${item.sequenceNumber}`,
    item,
    states.get(item.stateId) || null,
  ));
}

function planeClaim(workspace, key, item, stateGroup) {
  return {
    workspace,
    key,
    createdAt: item.createdAt,
    stateGroup,
    updatedAt: item.updatedAt,
  };
}

function releaseClaim(release) {
  return {
    id: release.id,
    tagName: release.tagName,
    publishedAt: release.publishedAt,
    commit: release.commit,
    commitStatus: release.commitStatus,
  };
}

function deploymentClaim(receipt) {
  return {
    receiptId: receipt.id,
    repository: receipt.repository,
    environment: receipt.environment,
    commit: receipt.commit,
    status: receipt.status,
    deployedAt: receipt.deployedAt,
    observedAt: receipt.observedAt,
    provider: receipt.provider,
  };
}

function assertUniquePortableRecords(snapshot) {
  ensure(
    snapshot.deliveryRecords.every(
      (record) =>
        DELIVERY_RECORD_ID.test(record.id ?? "")
        && isSafeProviderText(record.id),
    ),
    "Delivery evidence record IDs must be portable single-line identifiers.",
  );
  ensure(
    new Set(snapshot.deliveryRecords.map((record) => record.id)).size
      === snapshot.deliveryRecords.length,
    "Delivery evidence record IDs must be unique.",
  );
  ensure(
    new Set(snapshot.wipByProject.map((row) => row.project)).size
      === snapshot.wipByProject.length,
    "Delivery evidence WIP projects must be unique.",
  );
}

function assertSafeSources(snapshot) {
  for (const [name, source] of Object.entries(snapshot.sources)) {
    ensure(
      source.reason === null
        || (SAFE_REASON.test(source.reason) && isSafeProviderText(source.reason)),
      "Delivery evidence source reasons must be portable single-line text.",
    );
    assertSourceState(name, source, snapshot.capturedAt);
  }
}

function assertSourceState(name, source, capturedAt) {
  ensure(
    source.observations.every((item) => isPortableIdentifier(item.id)),
    `${name} source observation IDs must be portable identifiers.`,
  );
  if (source.status === "available") {
    ensure(
      source.reason === null && source.observations.length > 0,
      `Available ${name} source requires observations and no reason.`,
    );
  } else {
    ensure(
      Boolean(source.reason) && source.observations.length === 0,
      `Unavailable ${name} source requires a reason and no observations.`,
    );
  }
  ensure(
    !source.observations.some(
      (item) =>
        isJsonDateTime(item.version)
        && Date.parse(item.version) > Date.parse(capturedAt),
    ),
    `${name} source observation cannot be newer than the delivery snapshot.`,
  );
}

function assertWipRows(rows) {
  for (const row of rows) {
    ensure(
      row.overLimit === (row.activeItemCount > 3)
        && row.aging3dCount <= row.activeItemCount,
      "Delivery evidence WIP counts conflict.",
    );
  }
}

function assertRecordEvidence(record, snapshot) {
  assertProviderRecordEvidence(record, snapshot.sources.provider);
  assertPlaneEvidence(record.plane, snapshot.sources.plane, snapshot.capturedAt);
  assertCiEvidence(record, snapshot.sources.buildkite, snapshot.capturedAt);
  assertReleaseEvidence(
    record.release,
    snapshot.sources.githubRelease,
    snapshot.capturedAt,
  );
  assertDeploymentEvidence(record, snapshot);
}

function assertProviderRecordEvidence(record, source) {
  ensure(
    source.status === "available",
    "Delivery record requires an available provider source observation.",
  );
  const expected = digestClaim({
    id: record.id,
    linkBasis: record.linkBasis,
    pullRequestNumber: record.pullRequestNumber,
    headCommit: record.headCommit,
    mergeCommit: record.mergeCommit,
    planeStoryId: record.plane.key,
  });
  assertBoundClaim(
    record.sourceClaimDigest,
    expected,
    source,
    "Delivery record is not bound to the provider observation.",
  );
}

function assertPlaneEvidence(plane, source, capturedAt) {
  if (plane.status !== "linked") return;
  ensure(
    hasLinkedPlaneFields(plane),
    "Linked Plane evidence requires exact workspace, item, and claim fields.",
  );
  ensure(
    source.status === "available",
    "Linked Plane evidence requires an available Plane source observation.",
  );
  const expected = digestClaim({
    workspace: plane.workspace,
    key: plane.key,
    createdAt: plane.createdAt,
    stateGroup: plane.stateGroup,
    updatedAt: plane.updatedAt,
  });
  assertBoundClaim(
    plane.sourceClaimDigest,
    expected,
    source,
    "Linked Plane evidence is not bound to the Plane observation.",
  );
  assertEventNotAfterCapture(plane.updatedAt, capturedAt, "Plane");
}

function hasLinkedPlaneFields(plane) {
  return [
    isPortableIdentifier(plane.workspace),
    plane.key,
    isJsonDateTime(plane.createdAt),
    plane.stateGroup,
    isJsonDateTime(plane.updatedAt),
    plane.sourceClaimDigest,
  ].every(Boolean);
}

function assertCiEvidence(record, source, capturedAt) {
  const ci = record.ci;
  if (!["passed", "failed"].includes(ci.status)) return;
  ensure(
    hasDecisiveCiFields(ci),
    "Decisive CI evidence requires pipeline, build number, finishedAt, and claim digest.",
  );
  ensure(
    source.status === "available",
    "Decisive CI evidence requires an available Buildkite source observation.",
  );
  const expected = digestClaim({
    pipeline: ci.pipeline,
    buildNumber: ci.buildNumber,
    commit: record.headCommit,
    status: ci.status,
    finishedAt: ci.finishedAt,
  });
  assertBoundClaim(
    ci.sourceClaimDigest,
    expected,
    source,
    "CI evidence is not bound to the Buildkite observation.",
  );
  assertEventNotAfterCapture(ci.finishedAt, capturedAt, "CI");
}

function hasDecisiveCiFields(ci) {
  return [
    ci.pipeline,
    Number.isInteger(ci.buildNumber),
    isJsonDateTime(ci.finishedAt),
    ci.sourceClaimDigest,
  ].every(Boolean);
}

function assertReleaseEvidence(release, source, capturedAt) {
  if (release.status !== "shipped") return;
  ensure(
    hasShippedReleaseFields(release),
    "Shipped release evidence requires exact release fields.",
  );
  ensure(
    source.status === "available",
    "Shipped release evidence requires an available GitHub Release source observation.",
  );
  const expected = digestClaim(releaseClaim({
    id: release.releaseId,
    tagName: release.tagName,
    publishedAt: release.publishedAt,
    commit: release.commit,
    commitStatus: "resolved",
  }));
  assertBoundClaim(
    release.sourceClaimDigest,
    expected,
    source,
    "Shipped release evidence is not bound to the GitHub Release observation.",
  );
  assertEventNotAfterCapture(release.publishedAt, capturedAt, "Release");
}

function hasShippedReleaseFields(release) {
  return [
    release.releaseId,
    release.tagName,
    isJsonDateTime(release.publishedAt),
    release.commit,
    release.sourceClaimDigest,
  ].every(Boolean);
}

function assertDeploymentEvidence(record, snapshot) {
  const deployment = record.deployment;
  if (!["passed", "failed"].includes(deployment.status)) return;
  ensure(
    hasDecisiveDeploymentFields(deployment),
    "Decisive deployment evidence requires exact receipt fields.",
  );
  ensure(
    snapshot.sources.deployment.status === "available",
    "Decisive deployment evidence requires an available deployment source observation.",
  );
  ensure(
    changeCommits(record).includes(deployment.commit),
    "Deployment evidence commit is not bound to the delivery record.",
  );
  const expected = digestClaim({
    receiptId: deployment.receiptId,
    repository: snapshot.repository,
    environment: deployment.environment,
    commit: deployment.commit,
    status: deployment.status,
    deployedAt: deployment.deployedAt,
    observedAt: deployment.observedAt,
    provider: deployment.provider,
  });
  assertBoundClaim(
    deployment.sourceClaimDigest,
    expected,
    snapshot.sources.deployment,
    "Deployment evidence is not bound to the receipt observation.",
  );
  if (deployment.deployedAt !== null) {
    assertEventNotAfterCapture(
      deployment.deployedAt,
      snapshot.capturedAt,
      "Deployment",
    );
  }
  assertEventNotAfterCapture(deployment.observedAt, snapshot.capturedAt, "Deployment");
}

function hasDecisiveDeploymentFields(deployment) {
  const required = [
    deployment.receiptId,
    deployment.environment,
    deployment.provider,
    deployment.commit,
    isJsonDateTime(deployment.observedAt),
    deployment.sourceClaimDigest,
  ].every(Boolean);
  if (!required) return false;
  if (deployment.status === "failed") {
    return deployment.deployedAt === null
      || isJsonDateTime(deployment.deployedAt);
  }
  return isJsonDateTime(deployment.deployedAt);
}

function assertBoundClaim(actual, expected, source, message) {
  ensure(
    actual === expected
      && source.observations.some(
        (item) => item.claimDigests.includes(expected),
      ),
    message,
  );
}

function assertEventNotAfterCapture(value, capturedAt, label) {
  ensure(
    Date.parse(value) <= Date.parse(capturedAt),
    `${label} evidence cannot be newer than the delivery snapshot.`,
  );
}

function ciStatus(state) {
  if (state === "passed") return "passed";
  if (["failed", "canceled", "cancelled"].includes(state)) return "failed";
  if (["scheduled", "running", "canceling", "cancelling"].includes(state)) {
    return "in_progress";
  }
  return "blocked";
}

function wipByProject(snapshot, capturedAt) {
  if (snapshot.status !== "available") return [];
  const states = new Map(
    snapshot.states.map((state) => [state.id, state.group]),
  );
  const projects = new Map(
    snapshot.projects.map((project) => [project.id, project.identifier]),
  );
  return [...projects].map(([projectId, project]) => {
    const active = snapshot.workItems.filter(
      (item) =>
        item.projectId === projectId
        && states.get(item.stateId) === "started",
    );
    const aging3dCount = active.filter(
      (item) =>
        Date.parse(capturedAt) - Date.parse(item.updatedAt)
        >= 3 * 24 * 60 * 60 * 1000,
    ).length;
    return {
      project,
      activeItemCount: active.length,
      aging3dCount,
      overLimit: active.length > 3,
    };
  }).sort((left, right) => left.project.localeCompare(right.project));
}

function latestTimestamp(values) {
  const valid = values.filter(isJsonDateTime);
  ensure(
    valid.length > 0,
    "Delivery evidence requires at least one capture timestamp.",
  );
  return valid.sort(
    (left, right) => Date.parse(right) - Date.parse(left),
  )[0];
}

function latestBy(values, timestampFor) {
  return values.sort(
    (left, right) =>
      Date.parse(timestampFor(right)) - Date.parse(timestampFor(left)),
  )[0] ?? null;
}

function digestClaim(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function availableSource(observations) {
  return { status: "available", reason: null, observations };
}

function unavailableSource(reason, status = "unavailable") {
  return { status, reason, observations: [] };
}

function sameRepository(left, right) {
  return typeof left === "string"
    && left.toLowerCase() === String(right ?? "").toLowerCase();
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
