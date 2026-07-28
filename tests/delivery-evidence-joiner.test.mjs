import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  joinDeliveryEvidence,
  validateDeliveryEvidenceSnapshot,
} from "../scripts/lib/delivery-evidence-joiner.mjs";
import { isJsonDateTime } from "../scripts/lib/json-schema-validator.mjs";
import {
  buildkite,
  deployment,
  fixture,
  plane,
  provider,
  releases,
} from "./helpers/delivery-evidence-fixture.mjs";

function join(overrides = {}) {
  return joinDeliveryEvidence({
    providerSnapshot: provider(),
    planeSnapshot: plane(),
    buildkiteSnapshots: [buildkite()],
    releaseSnapshot: releases(),
    ...overrides,
  });
}

function deployedSnapshot() {
  return join({
    deploymentReceipts: [deployment()],
    deploymentEnvironment: "production",
  });
}

test("delivery join binds exact Plane, CI, release, and deployment evidence", () => {
  const snapshot = deployedSnapshot();
  const record = snapshot.deliveryRecords[0];
  assert.equal(record.plane.status, "linked");
  assert.match(record.sourceClaimDigest, /^[0-9a-f]{64}$/);
  assert.match(record.plane.sourceClaimDigest, /^[0-9a-f]{64}$/);
  assert.equal(record.ci.status, "passed");
  assert.match(record.ci.sourceClaimDigest, /^[0-9a-f]{64}$/);
  assert.equal(record.release.status, "shipped");
  assert.match(record.release.sourceClaimDigest, /^[0-9a-f]{64}$/);
  assert.equal(record.deployment.status, "passed");
  assert.equal(record.deployment.commit, fixture.commit);
  assert.match(record.deployment.sourceClaimDigest, /^[0-9a-f]{64}$/);
  console.log("delivery_claim_binding_count=5");
});

test("delivery evidence schema requires decision claim digests", async () => {
  const schema = JSON.parse(await readFile(
    "schemas/delivery-evidence-snapshot.v0.1.schema.json",
    "utf8",
  ));
  assert(schema.$defs.record.required.includes("sourceClaimDigest"));
  assert(schema.$defs.plane.required.includes("sourceClaimDigest"));
  assert(schema.$defs.ci.required.includes("sourceClaimDigest"));
  assert(schema.$defs.release.required.includes("sourceClaimDigest"));
  assert(schema.$defs.deployment.required.includes("sourceClaimDigest"));
  assert.equal(schema.$defs.observation.properties.claimDigests.uniqueItems, true);
});

test("delivery snapshot preserves exact source provenance", () => {
  const snapshot = deployedSnapshot();
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(snapshot.sources).map(([name, source]) => [
        name,
        source.observations.map((item) => item.id),
      ]),
    ),
    {
      provider: ["provider:IntelIP/Tabellio"],
      plane: ["plane:intelip"],
      buildkite: ["buildkite:intelip/tabellio"],
      githubRelease: ["github-release:IntelIP/Tabellio"],
      deployment: ["deployment:cloud-run:deploy-1"],
    },
  );
});

test("delivery join rejects cross-authority evidence", () => {
  const wrongBuild = buildkite();
  wrongBuild.repository = "IntelIP/Other";
  assert.throws(
    () => join({ buildkiteSnapshots: [wrongBuild] }),
    /Buildkite snapshot repository mismatch/,
  );
  assert.throws(
    () => join({
      deploymentReceipts: [deployment({ repository: "IntelIP/Other" })],
      deploymentEnvironment: "production",
    }),
    /Deployment receipt repository mismatch/,
  );
  const wrongPlaneProvider = provider();
  wrongPlaneProvider.sources.plane.workspace = "other";
  assert.throws(
    () => join({ providerSnapshot: wrongPlaneProvider }),
    /workspace mismatch/,
  );
});

test("delivery join uses one designated Buildkite pipeline", () => {
  assert.throws(
    () => join({
      buildkiteSnapshots: [
        buildkite(),
        { ...buildkite(), pipeline: "auxiliary" },
      ],
    }),
    /one designated Buildkite pipeline/,
  );
});

test("delivery join preserves terminal CI and blocked deployment states", () => {
  for (const state of ["skipped", "not_run", "blocked"]) {
    const snapshot = buildkite();
    snapshot.builds[0].state = state;
    assert.equal(
      join({ buildkiteSnapshots: [snapshot] }).deliveryRecords[0].ci.status,
      "blocked",
    );
  }
  const blocked = join({
    deploymentBlockedReason: "Provider unavailable.",
    deploymentEnvironment: "production",
  });
  assert.equal(blocked.sources.deployment.status, "blocked");
  assert.equal(blocked.deliveryRecords[0].deployment.status, "blocked");
  const failed = join({
    deploymentReceipts: [deployment({ status: "failed", deployedAt: null })],
    deploymentEnvironment: "production",
  });
  assert.equal(failed.deliveryRecords[0].deployment.status, "failed");
  assert.equal(failed.deliveryRecords[0].deployment.deployedAt, null);
});

test("delivery join restricts runtime proof to the target environment", () => {
  const snapshot = join({
    deploymentReceipts: [deployment({ environment: "staging" })],
    deploymentEnvironment: "production",
  });
  assert.equal(snapshot.sources.deployment.status, "unavailable");
  assert.equal(snapshot.deliveryRecords[0].deployment.status, "unavailable");
  assert.equal(snapshot.deliveryRecords[0].deployment.environment, "production");
});

test("delivery join follows landed squash commits", () => {
  const mergeCommit = "b".repeat(40);
  const providerSnapshot = provider();
  providerSnapshot.deliveryChanges[0].mergeCommit = mergeCommit;
  const releaseSnapshot = releases();
  releaseSnapshot.releases[0].commit = mergeCommit;
  const snapshot = join({
    providerSnapshot,
    releaseSnapshot,
    deploymentReceipts: [deployment({ commit: mergeCommit })],
    deploymentEnvironment: "production",
  });
  assert.equal(snapshot.deliveryRecords[0].release.status, "shipped");
  assert.equal(snapshot.deliveryRecords[0].deployment.status, "passed");
  assert.equal(snapshot.deliveryRecords[0].deployment.commit, mergeCommit);
});

test("delivery join selects earliest post-merge release", () => {
  const providerSnapshot = provider();
  providerSnapshot.deliveryChanges[0].storyCreatedAt =
    "2026-07-25T08:00:00.000Z";
  providerSnapshot.deliveryChanges[0].firstActivityAt =
    "2026-07-25T09:00:00.000Z";
  providerSnapshot.deliveryChanges[0].mergedAt = "2026-07-25T10:00:00.000Z";
  const releaseSnapshot = releases();
  releaseSnapshot.releases = [
    {
      ...releaseSnapshot.releases[0],
      id: "later",
      tagName: "v0.6.0",
      publishedAt: "2026-07-25T11:30:00.000Z",
    },
    {
      ...releaseSnapshot.releases[0],
      publishedAt: "2026-07-25T11:00:00.000Z",
    },
    {
      ...releaseSnapshot.releases[0],
      id: "early",
      tagName: "v0.4.0",
      publishedAt: "2026-07-25T09:00:00.000Z",
    },
  ];
  const snapshot = join({ providerSnapshot, releaseSnapshot });
  assert.equal(
    snapshot.deliveryRecords[0].release.publishedAt,
    "2026-07-25T11:00:00.000Z",
  );
});

test("delivery join never ships an unmerged change", () => {
  const providerSnapshot = provider();
  providerSnapshot.deliveryChanges[0].mergedAt = null;
  const snapshot = join({ providerSnapshot });
  assert.equal(snapshot.deliveryRecords[0].release.status, "unreleased");
});

test("delivery join ages WIP at Plane observation time", () => {
  const planeSnapshot = plane();
  planeSnapshot.capturedAt = "2026-07-22T12:00:00.000Z";
  planeSnapshot.workItems[0].createdAt = "2026-07-20T12:00:00.000Z";
  planeSnapshot.workItems[0].updatedAt = "2026-07-20T12:00:01.000Z";
  const snapshot = join({ planeSnapshot });
  assert.equal(snapshot.wipByProject[0].aging3dCount, 0);
});

test("delivery snapshot rejects duplicate records, projects, and contradictory WIP", () => {
  for (const mutate of [
    (snapshot) => snapshot.deliveryRecords.push(
      structuredClone(snapshot.deliveryRecords[0]),
    ),
    (snapshot) => snapshot.wipByProject.push(
      structuredClone(snapshot.wipByProject[0]),
    ),
    (snapshot) => {
      snapshot.wipByProject[0].activeItemCount = 10;
      snapshot.wipByProject[0].overLimit = false;
    },
  ]) {
    const snapshot = join();
    mutate(snapshot);
    assert.throws(
      () => validateDeliveryEvidenceSnapshot(snapshot),
      /must be unique|WIP counts conflict/,
    );
  }
});

test("delivery snapshot rejects unsafe source text and future evidence", () => {
  for (const reason of [
    "missing\n\n## Forged decision",
    "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    "/Users/private/evidence.json",
  ]) {
    const unsafe = join();
    unsafe.sources.plane.status = "blocked";
    unsafe.sources.plane.reason = reason;
    unsafe.sources.plane.observations = [];
    assert.throws(
      () => validateDeliveryEvidenceSnapshot(unsafe),
      /portable single-line|oneOf contract/,
    );
  }
  const unsafeRecord = join();
  unsafeRecord.deliveryRecords[0].id = "/Users/private/change";
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(unsafeRecord),
    /portable single-line identifiers|required pattern/,
  );
  const unsafeObservation = join();
  unsafeObservation.sources.plane.observations[0].id =
    "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(unsafeObservation),
    /observation IDs must be portable|prohibited contract/,
  );
  const future = join();
  future.sources.plane.observations[0].version =
    "2026-07-25T12:00:00.001Z";
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(future),
    /cannot be newer/,
  );
});

test("delivery schema enforces allOf siblings and not constraints", () => {
  const unsafeRepository = join();
  unsafeRepository.repository = "/Users/private/repo";
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(unsafeRepository),
    /required pattern/,
  );
  const unsafeRelease = join();
  unsafeRelease.deliveryRecords[0].release.releaseId =
    "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(unsafeRelease),
    /prohibited contract|oneOf contract|not bound/,
  );
  assert.equal(isJsonDateTime("2026-07-25T12:00:00-07:00"), true);
});

test("delivery snapshot rejects unsupported successful and failed claims", () => {
  for (const ciStatus of ["passed", "failed"]) {
    const snapshot = join();
    snapshot.deliveryRecords[0].ci = {
      status: ciStatus,
      pipeline: null,
      buildNumber: null,
      finishedAt: null,
      sourceClaimDigest: null,
    };
    assert.throws(
      () => validateDeliveryEvidenceSnapshot(snapshot),
      /Decisive CI evidence requires/,
    );
  }
  const snapshot = join();
  snapshot.deliveryRecords[0].plane = {
    status: "linked",
    workspace: "intelip",
    key: null,
    createdAt: null,
    stateGroup: null,
    updatedAt: null,
    sourceClaimDigest: null,
  };
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(snapshot),
    /not bound to the provider|Linked Plane evidence requires/,
  );
});

test("delivery snapshot binds CI, release, and deployment decisions to claims", () => {
  for (const mutate of [
    (record) => { record.pullRequestNumber = 99; },
    (record) => { record.plane.stateGroup = "completed"; },
    (record) => { record.ci.status = "failed"; },
    (record) => { record.release.tagName = "v9.9.9"; },
    (record) => { record.deployment.provider = "vercel"; },
  ]) {
    const snapshot = deployedSnapshot();
    mutate(snapshot.deliveryRecords[0]);
    assert.throws(
      () => validateDeliveryEvidenceSnapshot(snapshot),
      /not bound/,
    );
  }
});

test("delivery snapshot rejects future record events", () => {
  for (const mutate of [
    (record) => { record.plane.updatedAt = "2026-07-25T12:00:00.001Z"; },
    (record) => { record.ci.finishedAt = "2026-07-25T12:00:00.001Z"; },
    (record) => { record.release.publishedAt = "2026-07-25T12:00:00.001Z"; },
    (record) => { record.deployment.observedAt = "2026-07-25T12:00:00.001Z"; },
  ]) {
    const snapshot = deployedSnapshot();
    mutate(snapshot.deliveryRecords[0]);
    assert.throws(
      () => validateDeliveryEvidenceSnapshot(snapshot),
      /cannot be newer|not bound/,
    );
  }
});

test("delivery join requires immutable Plane creation identity", () => {
  const planeSnapshot = plane();
  planeSnapshot.workItems[0].createdAt = "2026-07-25T11:59:59.000Z";
  assert.equal(
    join({ planeSnapshot }).deliveryRecords[0].plane.status,
    "unlinked",
  );
});
