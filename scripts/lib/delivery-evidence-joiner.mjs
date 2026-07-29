import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { validateBuildkiteBuildSnapshot } from "./buildkite-build-collector.mjs";
import { canonicalJson } from "./context-packet.mjs";
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
const DEPLOYMENT_BLOCK_VERSION =
  "tabellio-deployment-collection-block/v0.1";
const SCHEMA = JSON.parse(readFileSync(
  new URL("../../schemas/delivery-evidence-snapshot.v0.1.schema.json", import.meta.url),
  "utf8",
));
const DELIVERY_RECORD_ID = /^[^\r\n|#`][^\r\n|#`]{0,199}$/;
const SAFE_REASON = /^[^\r\n]{1,500}$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BUILDKITE_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,126}[A-Za-z0-9])?$/;
const OBSERVATION_CONTRACTS = {
  provider: providerEvidenceContract,
  plane: planeEvidenceContract,
  buildkite: buildkiteEvidenceContract,
  githubRelease: releaseEvidenceContract,
  deployment: deploymentEvidenceContract,
};

export function joinDeliveryEvidence({
  providerSnapshot,
  planeSnapshot,
  buildkiteAuthority,
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
    buildkiteAuthority,
    buildkiteSnapshots,
    releaseSnapshot,
    deploymentReceipts,
    capturedAt,
  });
  assertJoinBindings({
    providerSnapshot,
    planeSnapshot,
    buildkiteAuthority,
    buildkiteSnapshots,
    releaseSnapshot,
    deploymentReceipts,
    deploymentBlockedReason,
    deploymentEnvironment,
  });
  const targetReceipts = deploymentReceipts.filter(
    (receipt) => receipt.environment === deploymentEnvironment,
  );
  const buildkiteSourceStatus = buildkiteEvidenceStatus(
    buildkiteSnapshots,
    providerSnapshot.sources.buildkite.status,
  );
  const context = recordContext({
    providerSnapshot,
    planeSnapshot,
    buildkiteSnapshots,
    buildkiteSourceStatus,
    releaseSnapshot,
    targetReceipts,
    deploymentBlockedReason,
    deploymentEnvironment,
  });
  const sources = {
    provider: availableSource([
      observation(
        boundedObservationId("provider", providerSnapshot.repository),
        providerSnapshot.capturedAt,
        providerSnapshot,
        providerSnapshot.deliveryChanges.map(providerChangeClaim),
      ),
    ]),
    plane: authoritySourceState(
      providerSnapshot.sources.plane.status,
      planeSnapshot.status,
      planeSnapshot,
      boundedObservationId("plane", planeSnapshot.workspace),
      planeClaims(planeSnapshot),
    ),
    buildkite: aggregateBuildkite(
      buildkiteSnapshots,
      providerSnapshot.sources.buildkite.status,
    ),
    githubRelease: authoritySourceState(
      providerSnapshot.sources.github.status,
      releaseSnapshot.status,
      releaseSnapshot,
      boundedObservationId("github-release", releaseSnapshot.repository),
      releaseSnapshot.releases.map(releaseClaim),
    ),
    deployment: deploymentSource(
      targetReceipts,
      deploymentBlockedReason,
      deploymentEnvironment,
      providerSnapshot.repository,
      capturedAt,
    ),
  };
  return validateDeliveryEvidenceSnapshot({
    schemaVersion: SCHEMA_VERSION,
    repository: providerSnapshot.repository,
    capturedAt: latestSourceObservation(sources),
    ciAuthority: buildkiteAuthority,
    deploymentEnvironment,
    sources,
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
  ensure(
    snapshot.capturedAt === latestSourceObservation(snapshot.sources),
    "Delivery evidence capturedAt must match its newest source observation.",
  );
  assertUniquePortableRecords(snapshot);
  assertSafeSources(snapshot);
  assertWipRows(snapshot.wipByProject);
  for (const record of snapshot.deliveryRecords) {
    assertRecordEvidence(record, snapshot);
  }
  assertDerivedEvidence(snapshot);
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
}

function assertJoinBindings(input) {
  assertBuildkiteBinding(input);
  assertRepositoryBindings(input);
  assertPlaneBinding(input);
  assertDeploymentBinding(input);
}

function assertBuildkiteBinding({
  providerSnapshot,
  buildkiteAuthority,
  buildkiteSnapshots,
}) {
  ensure(
    buildkiteSnapshots.length <= 1,
    "Delivery evidence requires one designated Buildkite pipeline snapshot.",
  );
  ensure(
    validBuildkiteAuthority(buildkiteAuthority),
    "Delivery evidence requires a valid designated Buildkite authority.",
  );
  ensure(
    buildkiteSnapshots.every(
      (snapshot) =>
        snapshot.organization === buildkiteAuthority.organization
        && snapshot.pipeline === buildkiteAuthority.pipeline,
    ),
    "Buildkite snapshot authority mismatch.",
  );
  ensure(
    providerSnapshot.sources.buildkite.status === "available"
      || !buildkiteSnapshots.some((snapshot) => snapshot.status === "available"),
    "Provider and Buildkite source availability mismatch.",
  );
  for (const snapshot of buildkiteSnapshots) {
    assertAvailableCollectorVersion(
      providerSnapshot.sources.buildkite,
      snapshot,
      "Buildkite",
    );
  }
}

function validBuildkiteAuthority(authority) {
  return Boolean(authority)
    && validBuildkiteSlug(authority.organization)
    && validBuildkiteSlug(authority.pipeline);
}

function validBuildkiteSlug(value) {
  return typeof value === "string" && BUILDKITE_SLUG.test(value);
}

function assertRepositoryBindings({
  providerSnapshot,
  buildkiteSnapshots,
  releaseSnapshot,
  deploymentReceipts,
}) {
  const repository = providerSnapshot.repository;
  ensure(
    sameRepository(releaseSnapshot.repository, repository),
    "Release snapshot repository mismatch.",
  );
  ensure(
    buildkiteSnapshots.every(
      (snapshot) => sameRepository(snapshot.repository, repository),
    ),
    "Buildkite snapshot repository mismatch.",
  );
  ensure(
    deploymentReceipts.every(
      (receipt) => sameRepository(receipt.repository, repository),
    ),
    "Deployment receipt repository mismatch.",
  );
}

function assertPlaneBinding({
  providerSnapshot,
  planeSnapshot,
  releaseSnapshot,
}) {
  const providerPlane = providerSnapshot.sources.plane;
  ensure(
    isPortableIdentifier(providerPlane.workspace),
    "Provider Plane workspace is invalid.",
  );
  ensure(
    providerPlane.workspace === planeSnapshot.workspace,
    "Provider and Plane snapshot workspace mismatch.",
  );
  ensure(
    providerPlane.status === "available"
      || planeSnapshot.status !== "available",
    "Provider and Plane source availability mismatch.",
  );
  ensure(
    providerSnapshot.sources.github.status === "available"
      || releaseSnapshot.status !== "available",
    "Provider and GitHub Release source availability mismatch.",
  );
  assertAvailableCollectorVersion(providerPlane, planeSnapshot, "Plane");
  assertAvailableCollectorVersion(
    providerSnapshot.sources.github,
    releaseSnapshot,
    "GitHub Release",
    { allowOlder: true },
  );
}

function assertAvailableCollectorVersion(
  providerSource,
  collectorSnapshot,
  label,
  { allowOlder = false } = {},
) {
  if (
    providerSource.status !== "available"
    || collectorSnapshot.status !== "available"
  ) return;
  if (!isJsonDateTime(providerSource.version)) return;
  const versionMatches = allowOlder
    ? Date.parse(collectorSnapshot.capturedAt) <= Date.parse(providerSource.version)
    : providerSource.version === collectorSnapshot.capturedAt;
  ensure(
    versionMatches,
    `${label} snapshot version does not match provider authority.`,
  );
}

function assertDeploymentBinding({
  deploymentReceipts,
  deploymentBlockedReason,
  deploymentEnvironment,
}) {
  if (deploymentBlockedReason !== null) {
    ensure(
      typeof deploymentBlockedReason === "string"
        && SAFE_REASON.test(deploymentBlockedReason)
        && isSafeProviderText(deploymentBlockedReason),
      "Deployment blocked reason is invalid.",
    );
  }
  if (deploymentEnvironment !== null) {
    ensure(
      ENVIRONMENT.test(deploymentEnvironment),
      "Deployment environment is invalid.",
    );
  }
  ensure(
    !(deploymentReceipts.length || deploymentBlockedReason !== null)
      || deploymentEnvironment !== null,
    "Deployment evidence requires a designated target environment.",
  );
  assertDeploymentCollectionConsistency(
    deploymentReceipts,
    deploymentBlockedReason,
  );
}

function assertDeploymentCollectionConsistency(receipts, blockedReason) {
  ensure(
    blockedReason === null || receipts.length === 0,
    "Blocked deployment collection cannot include decisive receipts.",
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
    planeSourceStatus: input.planeSourceStatus
      ?? authorityEvidenceStatus(
        providerSnapshot.sources.plane.status,
        planeSnapshot.status,
      ),
    buildkiteSnapshots,
    buildkiteSourceStatus: input.buildkiteSourceStatus
      ?? buildkiteEvidenceStatus(
        buildkiteSnapshots,
        providerSnapshot.sources.buildkite.status,
      ),
    releaseSnapshot,
    releaseSourceStatus: input.releaseSourceStatus
      ?? authorityEvidenceStatus(
        providerSnapshot.sources.github.status,
        releaseSnapshot.status,
      ),
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
    mergedAt: change.mergedAt || null,
    releaseCommit: change.releaseCommit || null,
    sourceClaimDigest: digestClaim(providerChangeClaim(change)),
    plane: planeEvidenceFor(change, context),
    ci: ciEvidenceFor(
      build,
      context.buildkiteSourceStatus,
    ),
    release: releaseEvidenceFor(release, context.releaseSourceStatus),
    deployment: deploymentEvidenceFor(receipt, context),
  };
}

function assertReleaseTimestamp(change, release) {
  if (!change.releasedAt) return;
  ensure(
    release !== null,
    `Delivery change ${change.id} claims a release absent from source evidence.`,
  );
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
    status: missingPlaneStatus(context.planeSourceStatus),
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

function missingPlaneStatus(sourceStatus) {
  return sourceStatus === "available" ? "unlinked" : sourceStatus;
}

function ciEvidenceFor(build, sourceStatus) {
  if (!build) {
    return {
      status: sourceStatus === "blocked" ? "blocked" : "unavailable",
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

function releaseEvidenceFor(release, sourceStatus) {
  if (!release) {
    return {
      status: sourceStatus === "available" ? "unreleased" : sourceStatus,
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
  return builds.sort((left, right) => right.number - left.number)[0] ?? null;
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
  return releaseIdentityMatches(change, candidate)
    && releaseFollowsMerge(change, candidate);
}

function releaseIdentityMatches(change, candidate) {
  return Boolean(change.mergeCommit)
    && candidate.commitStatus === "resolved"
    && releaseCommitMatches(change, candidate);
}

function releaseCommitMatches(change, candidate) {
  if (change.releaseCommit) return candidate.commit === change.releaseCommit;
  return changeCommits(change).includes(candidate.commit);
}

function releaseFollowsMerge(change, candidate) {
  if (!change.mergedAt) return false;
  return Date.parse(candidate.publishedAt) >= Date.parse(change.mergedAt);
}

function latestReceiptFor(change, receipts, repository) {
  const commits = changeCommits(change);
  return latestBy(
    receipts.filter(
      (receipt) =>
        commits.includes(receipt.commit)
        && sameRepository(receipt.repository, repository)
        && (
          receipt.status !== "passed"
          || (
            change.mergeCommit
            && change.mergedAt
            && receiptFollowsMerge(receipt, change.mergedAt)
          )
        ),
    ),
    (receipt) => receipt.observedAt,
  );
}

function receiptFollowsMerge(receipt, mergedAt) {
  const eventAt = receipt.deployedAt ?? receipt.observedAt;
  return Date.parse(eventAt) >= Date.parse(mergedAt);
}

function changeCommits(change) {
  return [change.mergeCommit, change.headCommit].filter(Boolean);
}

function deploymentSource(
  receipts,
  blockedReason,
  environment,
  repository,
  capturedAt,
) {
  if (receipts.length) {
    return availableSource(receipts.map(deploymentObservation));
  }
  if (blockedReason !== null) {
    const block = {
      schemaVersion: DEPLOYMENT_BLOCK_VERSION,
      repository,
      environment,
      capturedAt,
      status: "blocked",
      reason: blockedReason,
    };
    return blockedSource(blockedReason, [
      observation(
        boundedObservationId("deployment-block", `${repository}:${environment}`),
        capturedAt,
        block,
      ),
    ]);
  }
  return unavailableSource(
    deploymentUnavailableReason(blockedReason, environment),
    deploymentUnavailableStatus(blockedReason),
  );
}

function deploymentUnavailableReason(blockedReason, environment) {
  if (blockedReason !== null) return blockedReason;
  return `No ${environment || "target"} deployment receipts collected.`;
}

function deploymentUnavailableStatus(blockedReason) {
  return blockedReason !== null ? "blocked" : "unavailable";
}

function deploymentObservation(receipt) {
  return observation(
    boundedObservationId(`deployment:${receipt.provider}`, receipt.id),
    receipt.observedAt,
    receipt,
    [deploymentClaim(receipt)],
  );
}

function aggregateBuildkite(snapshots, providerStatus) {
  const status = buildkiteEvidenceStatus(snapshots, providerStatus);
  if (status === "blocked") {
    if (providerStatus === "available" && snapshots[0]?.status === "blocked") {
      const snapshot = snapshots[0];
      return blockedSource(snapshot.reason, [
        observation(
          boundedObservationId(
            "buildkite",
            `${snapshot.organization}/${snapshot.pipeline}`,
          ),
          snapshot.capturedAt,
          snapshot,
        ),
      ]);
    }
    return unavailableSource("Buildkite evidence collection blocked.", "blocked");
  }
  if (status === "unavailable") {
    return unavailableSource("No Buildkite snapshots collected.");
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

function buildkiteEvidenceStatus(snapshots, providerStatus) {
  const key = `${providerStatus}:${Object(snapshots[0]).status || "missing"}`;
  return {
    "blocked:missing": "blocked",
    "blocked:blocked": "blocked",
    "unavailable:missing": "unavailable",
    "unavailable:blocked": "unavailable",
    "available:missing": "unavailable",
    "available:blocked": "blocked",
    "available:available": "available",
  }[key];
}

function sourceState(status, snapshot, identity, claims = []) {
  if (status === "available") {
    return availableSource([
      observation(identity, snapshot.capturedAt, snapshot, claims),
    ]);
  }
  return blockedSource(snapshot.reason ?? "Collector unavailable.", [
    observation(identity, snapshot.capturedAt, snapshot),
  ]);
}

function authoritySourceState(
  authorityStatus,
  collectorStatus,
  snapshot,
  identity,
  claims = [],
) {
  if (authorityStatus === "available") {
    return sourceState(collectorStatus, snapshot, identity, claims);
  }
  return unavailableSource(
    "Provider authority evidence unavailable.",
    authorityStatus,
  );
}

function authorityEvidenceStatus(authorityStatus, collectorStatus) {
  return authorityStatus === "available" ? collectorStatus : authorityStatus;
}

function observation(id, version, value, claims = []) {
  return {
    id,
    version,
    digest: digestClaim(value),
    claimDigests: [...new Set(claims.map(digestClaim))],
    evidence: structuredClone(value),
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
    mergedAt: change.mergedAt || null,
    releaseCommit: change.releaseCommit || null,
    planeStoryId: change.planeStoryId,
    validationStatus: change.validationStatus,
    hostedStatus: change.hostedStatus,
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
  assertAuthoritativeObservationCardinality(snapshot.sources);
  for (const [name, source] of Object.entries(snapshot.sources)) {
    ensure(
      source.reason === null
        || (SAFE_REASON.test(source.reason) && isSafeProviderText(source.reason)),
      "Delivery evidence source reasons must be portable single-line text.",
    );
    assertSourceState(name, source, snapshot.capturedAt);
    source.observations.forEach(
      (item) => assertObservationEvidence(name, item, snapshot),
    );
  }
}

function assertAuthoritativeObservationCardinality(sources) {
  for (const name of ["provider", "plane", "buildkite", "githubRelease"]) {
    ensure(
      sources[name].observations.length <= 1,
      `${name} source must contain at most one authoritative observation.`,
    );
  }
}

function assertObservationEvidence(name, item, snapshot) {
  ensure(
    item.digest === digestClaim(item.evidence),
    `${name} source digest does not match its evidence.`,
  );
  const contract = observationEvidenceContract(name, item.evidence, snapshot);
  ensure(
    item.id === contract.id && item.version === contract.version,
    `${name} source identity does not match its evidence.`,
  );
  ensure(
    sameDigestSet(
      item.claimDigests,
      contract.claims.map(digestClaim),
    ),
    `${name} source claims do not match its evidence.`,
  );
}

function observationEvidenceContract(name, evidence, snapshot) {
  return OBSERVATION_CONTRACTS[name](evidence, snapshot);
}

function providerEvidenceContract(evidence, snapshot) {
  assertProviderSnapshot(evidence, snapshot.capturedAt);
  ensure(
    sameRepository(evidence.repository, snapshot.repository),
    "Provider source evidence repository mismatch.",
  );
  return {
    id: boundedObservationId("provider", evidence.repository),
    version: evidence.capturedAt,
    claims: evidence.deliveryChanges.map(providerChangeClaim),
  };
}

function planeEvidenceContract(evidence, snapshot) {
  validatePlaneWorkItemSnapshot(evidence);
  const provider = snapshot.sources.provider.observations[0]?.evidence;
  ensure(
    evidence.workspace === provider?.sources?.plane?.workspace,
    "Plane source evidence authority mismatch.",
  );
  return {
    id: boundedObservationId("plane", evidence.workspace),
    version: evidence.capturedAt,
    claims: evidence.status === "available" ? planeClaims(evidence) : [],
  };
}

function buildkiteEvidenceContract(evidence, snapshot) {
  validateBuildkiteBuildSnapshot(evidence);
  ensure(
    sameRepository(evidence.repository, snapshot.repository)
      && evidence.organization === snapshot.ciAuthority.organization
      && evidence.pipeline === snapshot.ciAuthority.pipeline,
    "Buildkite source evidence authority mismatch.",
  );
  return {
    id: boundedObservationId(
      "buildkite",
      `${evidence.organization}/${evidence.pipeline}`,
    ),
    version: evidence.capturedAt,
    claims: evidence.status === "available"
      ? evidence.builds.map((build) => buildClaim({
        ...build,
        pipeline: evidence.pipeline,
      }))
      : [],
  };
}

function releaseEvidenceContract(evidence, snapshot) {
  validateGitHubReleaseSnapshot(evidence);
  ensure(
    sameRepository(evidence.repository, snapshot.repository),
    "GitHub Release source evidence authority mismatch.",
  );
  return {
    id: boundedObservationId("github-release", evidence.repository),
    version: evidence.capturedAt,
    claims: evidence.status === "available"
      ? evidence.releases.map(releaseClaim)
      : [],
  };
}

function deploymentEvidenceContract(evidence, snapshot) {
  if (evidence.schemaVersion === DEPLOYMENT_BLOCK_VERSION) {
    ensure(
      sameKeySet(evidence, [
        "schemaVersion",
        "repository",
        "environment",
        "capturedAt",
        "status",
        "reason",
      ])
        && sameRepository(evidence.repository, snapshot.repository)
        && evidence.environment === snapshot.deploymentEnvironment
        && isJsonDateTime(evidence.capturedAt)
        && evidence.status === "blocked"
        && SAFE_REASON.test(evidence.reason)
        && isSafeProviderText(evidence.reason),
      "Deployment block evidence is invalid or has an authority mismatch.",
    );
    return {
      id: boundedObservationId(
        "deployment-block",
        `${evidence.repository}:${evidence.environment}`,
      ),
      version: evidence.capturedAt,
      claims: [],
    };
  }
  validateDeploymentReceipt(evidence);
  ensure(
    sameRepository(evidence.repository, snapshot.repository)
      && evidence.environment === snapshot.deploymentEnvironment,
    "Deployment source evidence authority mismatch.",
  );
  return {
    id: boundedObservationId(`deployment:${evidence.provider}`, evidence.id),
    version: evidence.observedAt,
    claims: [deploymentClaim(evidence)],
  };
}

function sameDigestSet(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return actualSet.size === expectedSet.size
    && [...actualSet].every((value) => expectedSet.has(value));
}

function assertSourceState(name, source, capturedAt) {
  ensure(
    new Set(source.observations.map((item) => item.id)).size
      === source.observations.length,
    `${name} source observation IDs must be unique.`,
  );
  ensure(
    source.observations.every((item) => isPortableIdentifier(item.id)),
    `${name} source observation IDs must be portable identifiers.`,
  );
  if (source.status === "available") {
    ensure(
      source.reason === null && source.observations.length > 0,
      `Available ${name} source requires observations and no reason.`,
    );
  } else if (source.status === "blocked") {
    ensure(
      Boolean(source.reason),
      `Blocked ${name} source requires a reason.`,
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

function assertDerivedEvidence(snapshot) {
  ensure(
    snapshot.sources.provider.status === "available"
      && snapshot.sources.provider.reason === null
      && snapshot.sources.provider.observations.length === 1,
    "Provider source must remain available with one validated observation.",
  );
  const providerSnapshot =
    snapshot.sources.provider.observations[0].evidence;
  const planeSnapshot = sourceSnapshotOrBlocked(
    snapshot.sources.plane,
    blockedPlaneSnapshot(providerSnapshot, snapshot),
  );
  const releaseSnapshot = sourceSnapshotOrBlocked(
    snapshot.sources.githubRelease,
    blockedReleaseSnapshot(snapshot),
  );
  const buildkiteSnapshots =
    snapshot.sources.buildkite.observations.map((item) => item.evidence);
  const deploymentEvidence =
    snapshot.sources.deployment.observations.map((item) => item.evidence);
  const deploymentReceipts = deploymentEvidence.filter(
    (item) => item.schemaVersion !== DEPLOYMENT_BLOCK_VERSION,
  );
  const deploymentBlocks = deploymentEvidence.filter(
    (item) => item.schemaVersion === DEPLOYMENT_BLOCK_VERSION,
  );
  ensure(
    deploymentBlocks.length <= 1
      && !(deploymentBlocks.length && deploymentReceipts.length),
    "Deployment source evidence is ambiguous.",
  );
  assertDerivedCollectorVersions(
    providerSnapshot,
    planeSnapshot,
    buildkiteSnapshots,
    releaseSnapshot,
  );
  assertDerivedAuthorityStates(
    snapshot,
    providerSnapshot,
    planeSnapshot,
    releaseSnapshot,
  );
  assertDerivedCollectionStates(
    snapshot,
    providerSnapshot,
    buildkiteSnapshots,
    deploymentReceipts,
    deploymentBlocks[0] ?? null,
  );
  const context = recordContext({
    providerSnapshot,
    planeSnapshot,
    planeSourceStatus: snapshot.sources.plane.status,
    buildkiteSnapshots,
    buildkiteSourceStatus: snapshot.sources.buildkite.status,
    releaseSnapshot,
    releaseSourceStatus: snapshot.sources.githubRelease.status,
    targetReceipts: deploymentReceipts,
    deploymentBlockedReason: deploymentBlocks[0]?.reason ?? null,
    deploymentEnvironment: snapshot.deploymentEnvironment,
  });
  const expectedRecords = providerSnapshot.deliveryChanges.map(
    (change) => recordFor(change, context),
  );
  ensure(
    sameJson(snapshot.deliveryRecords, expectedRecords),
    "Delivery records do not match the validated source evidence.",
  );
  ensure(
    sameJson(
      snapshot.wipByProject,
      wipByProject(planeSnapshot, planeSnapshot.capturedAt),
    ),
    "Delivery WIP rows do not match the validated Plane evidence.",
  );
}

function assertDerivedCollectorVersions(
  providerSnapshot,
  planeSnapshot,
  buildkiteSnapshots,
  releaseSnapshot,
) {
  assertAvailableCollectorVersion(
    providerSnapshot.sources.plane,
    planeSnapshot,
    "Plane",
  );
  for (const buildkiteSnapshot of buildkiteSnapshots) {
    assertAvailableCollectorVersion(
      providerSnapshot.sources.buildkite,
      buildkiteSnapshot,
      "Buildkite",
    );
  }
  assertAvailableCollectorVersion(
    providerSnapshot.sources.github,
    releaseSnapshot,
    "GitHub Release",
    { allowOlder: true },
  );
}

function assertDerivedCollectionStates(
  snapshot,
  providerSnapshot,
  buildkiteSnapshots,
  deploymentReceipts,
  deploymentBlock,
) {
  const expectedBuildkite = aggregateBuildkite(
    buildkiteSnapshots,
    providerSnapshot.sources.buildkite.status,
  );
  ensure(
    snapshot.sources.buildkite.status === expectedBuildkite.status
      && snapshot.sources.buildkite.reason === expectedBuildkite.reason,
    "Buildkite source state does not match provider and collector evidence.",
  );
  const expectedDeployment = deploymentSource(
    deploymentReceipts,
    deploymentBlock?.reason ?? null,
    snapshot.deploymentEnvironment,
    snapshot.repository,
    snapshot.capturedAt,
  );
  ensure(
    snapshot.sources.deployment.status === expectedDeployment.status
      && snapshot.sources.deployment.reason === expectedDeployment.reason,
    "Deployment source state does not match collection evidence.",
  );
}

function assertDerivedAuthorityStates(
  snapshot,
  providerSnapshot,
  planeSnapshot,
  releaseSnapshot,
) {
  ensure(
    providerSnapshot.sources.plane.status !== "available"
      || snapshot.sources.plane.observations.length === 1,
    "Available Plane authority requires a validated collector observation.",
  );
  ensure(
    providerSnapshot.sources.github.status !== "available"
      || snapshot.sources.githubRelease.observations.length === 1,
    "Available GitHub authority requires a validated release observation.",
  );
  const expectedPlane = authoritySourceState(
    providerSnapshot.sources.plane.status,
    planeSnapshot.status,
    planeSnapshot,
    "",
  );
  const expectedRelease = authoritySourceState(
    providerSnapshot.sources.github.status,
    releaseSnapshot.status,
    releaseSnapshot,
    "",
  );
  ensure(
    snapshot.sources.plane.status === expectedPlane.status
      && snapshot.sources.plane.reason === expectedPlane.reason,
    "Plane source state does not match provider authority evidence.",
  );
  ensure(
    snapshot.sources.githubRelease.status === expectedRelease.status
      && snapshot.sources.githubRelease.reason === expectedRelease.reason,
    "GitHub Release source state does not match provider authority evidence.",
  );
}

function sourceSnapshotOrBlocked(source, blockedSnapshot) {
  return source.observations[0]?.evidence ?? blockedSnapshot;
}

function blockedPlaneSnapshot(providerSnapshot, snapshot) {
  return {
    schemaVersion: "tabellio-plane-work-items/v0.1",
    workspace: providerSnapshot.sources.plane.workspace,
    capturedAt: snapshot.capturedAt,
    status: "blocked",
    reason: snapshot.sources.plane.reason,
    projects: [],
    states: [],
    workItems: [],
  };
}

function blockedReleaseSnapshot(snapshot) {
  return {
    schemaVersion: "tabellio-github-release-snapshot/v0.1",
    repository: snapshot.repository,
    capturedAt: snapshot.capturedAt,
    status: "blocked",
    reason: snapshot.sources.githubRelease.reason,
    releases: [],
  };
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function assertRecordEvidence(record, snapshot) {
  assertProviderRecordEvidence(record, snapshot.sources.provider);
  assertPlaneEvidence(record.plane, snapshot.sources.plane, snapshot.capturedAt);
  assertCiEvidence(record, snapshot, snapshot.capturedAt);
  assertReleaseEvidence(
    record,
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
  const providerChange = source.observations[0]?.evidence?.deliveryChanges
    ?.find((change) => change.id === record.id);
  ensure(
    providerChange !== undefined,
    "Delivery record is absent from provider source evidence.",
  );
  ensure(
    sameJson(providerRecordIdentity(record), providerChangeIdentity(providerChange)),
    "Delivery record is not bound to the provider observation.",
  );
  const expected = digestClaim(providerChangeClaim(providerChange));
  assertBoundClaim(
    record.sourceClaimDigest,
    expected,
    source,
    "Delivery record is not bound to the provider observation.",
  );
}

function providerRecordIdentity(record) {
  return {
    id: record.id,
    linkBasis: record.linkBasis,
    pullRequestNumber: record.pullRequestNumber,
    headCommit: record.headCommit,
    mergeCommit: record.mergeCommit,
    mergedAt: record.mergedAt,
    releaseCommit: record.releaseCommit,
    planeStoryId: record.plane.key,
  };
}

function providerChangeIdentity(change) {
  const {
    validationStatus: _validationStatus,
    hostedStatus: _hostedStatus,
    ...identity
  } = providerChangeClaim(change);
  return identity;
}

function assertPlaneEvidence(plane, source, capturedAt) {
  assertBlockedSourcePreserved(source, plane.status, "Plane");
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

function assertCiEvidence(record, snapshot, capturedAt) {
  const source = snapshot.sources.buildkite;
  const ci = record.ci;
  assertBlockedSourcePreserved(source, ci.status, "Buildkite");
  if (!["passed", "failed"].includes(ci.status)) return;
  ensure(
    hasDecisiveCiFields(ci),
    "Decisive CI evidence requires pipeline, build number, finishedAt, and claim digest.",
  );
  ensure(
    source.status === "available",
    "Decisive CI evidence requires an available Buildkite source observation.",
  );
  ensure(
    ci.pipeline === snapshot.ciAuthority.pipeline,
    "CI evidence is not from the designated Buildkite pipeline.",
  );
  ensure(
    source.observations.some(
      (item) =>
        item.id
        === boundedObservationId(
          "buildkite",
          `${snapshot.ciAuthority.organization}/${snapshot.ciAuthority.pipeline}`,
        ),
    ),
    "Buildkite source observation does not match the designated authority.",
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

function assertReleaseEvidence(record, release, source, capturedAt) {
  assertBlockedSourcePreserved(source, release.status, "GitHub Release");
  if (release.status !== "shipped") return;
  ensure(
    hasShippedReleaseFields(release),
    "Shipped release evidence requires exact release fields.",
  );
  ensure(
    source.status === "available",
    "Shipped release evidence requires an available GitHub Release source observation.",
  );
  ensure(
    record.mergeCommit !== null,
    "Shipped release evidence requires a landed merge commit.",
  );
  ensure(
    releaseCommitMatchesRecord(record, release.commit),
    "Release evidence commit is not bound to the delivery record.",
  );
  ensure(
    isJsonDateTime(record.mergedAt)
      && Date.parse(release.publishedAt) >= Date.parse(record.mergedAt),
    "Release evidence predates the delivery record merge.",
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

function releaseCommitMatchesRecord(record, commit) {
  if (record.releaseCommit !== null) return record.releaseCommit === commit;
  return changeCommits(record).includes(commit);
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
  assertBlockedSourcePreserved(
    snapshot.sources.deployment,
    deployment.status,
    "Deployment",
  );
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
    deployment.environment === snapshot.deploymentEnvironment,
    "Deployment evidence is not from the designated environment.",
  );
  ensure(
    changeCommits(record).includes(deployment.commit),
    "Deployment evidence commit is not bound to the delivery record.",
  );
  assertPassedDeploymentChronology(record, deployment);
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

function assertPassedDeploymentChronology(record, deployment) {
  if (deployment.status !== "passed") return;
  ensure(
    record.mergeCommit !== null
      && isJsonDateTime(record.mergedAt)
      && Date.parse(deployment.deployedAt) >= Date.parse(record.mergedAt),
    "Passed deployment evidence requires landed post-merge proof.",
  );
}

function hasDecisiveDeploymentFields(deployment) {
  const required = [
    isPortableReceiptId(deployment.receiptId),
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

function isPortableReceiptId(value) {
  return isPortableIdentifier(value) && value.length <= 128;
}

function assertBlockedSourcePreserved(source, status, label) {
  ensure(
    source.status !== "blocked" || status === "blocked",
    `Blocked ${label} source must remain blocked in every delivery record.`,
  );
  ensure(
    source.status !== "unavailable" || status === "unavailable",
    `Unavailable ${label} source must remain unavailable in every delivery record.`,
  );
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
  if ([
    "canceling",
    "cancelling",
    "creating",
    "failing",
    "running",
    "scheduled",
    "waiting",
    "waiting_failed",
  ].includes(state)) {
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

function latestSourceObservation(sources) {
  return latestTimestamp(
    Object.values(sources).flatMap(
      (source) => source.observations.map((item) => item.version),
    ),
  );
}

function latestBy(values, timestampFor) {
  return values.sort(
    (left, right) =>
      Date.parse(timestampFor(right)) - Date.parse(timestampFor(left)),
  )[0] ?? null;
}

function digestClaim(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function availableSource(observations) {
  return { status: "available", reason: null, observations };
}

function unavailableSource(reason, status = "unavailable") {
  return { status, reason, observations: [] };
}

function blockedSource(reason, observations) {
  return { status: "blocked", reason, observations };
}

function sameKeySet(value, keys) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function sameRepository(left, right) {
  return typeof left === "string"
    && left.toLowerCase() === String(right ?? "").toLowerCase();
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
