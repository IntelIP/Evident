import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  joinDeliveryEvidence,
  validateDeliveryEvidenceSnapshot,
} from "../scripts/lib/delivery-evidence-joiner.mjs";
import { canonicalJson } from "../scripts/lib/context-packet.mjs";
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
    buildkiteAuthority: { organization: "intelip", pipeline: "tabellio" },
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

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(
      ([key, entry]) => [key, reverseKeys(entry)],
    ),
  );
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
    "schemas/delivery-evidence-snapshot.v0.2.schema.json",
    "utf8",
  ));
  assert(schema.$defs.record.required.includes("sourceClaimDigest"));
  assert(schema.$defs.plane.required.includes("sourceClaimDigest"));
  assert(schema.$defs.ci.required.includes("sourceClaimDigest"));
  assert(schema.$defs.release.required.includes("sourceClaimDigest"));
  assert(schema.$defs.deployment.required.includes("sourceClaimDigest"));
  assert.equal(schema.$defs.observation.properties.claimDigests.uniqueItems, true);
  assert(schema.$defs.observation.required.includes("evidence"));
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

test("delivery snapshot accepts semantically identical reordered JSON", () => {
  const reordered = reverseKeys(deployedSnapshot());
  assert.doesNotThrow(() => validateDeliveryEvidenceSnapshot(reordered));
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
  assert.throws(
    () => join({
      buildkiteSnapshots: [{ ...buildkite(), pipeline: "auxiliary" }],
    }),
    /authority mismatch/,
  );
});

test("delivery join binds available collectors to provider source versions", () => {
  for (const [source, input, message] of [
    ["plane", {
      planeSnapshot: { ...plane(), capturedAt: "2026-07-25T13:00:00.000Z" },
    }, /Plane snapshot version/],
    ["buildkite", {
      buildkiteSnapshots: [{
        ...buildkite(),
        capturedAt: "2026-07-25T13:00:00.000Z",
      }],
    }, /Buildkite snapshot version/],
    ["github", {
      releaseSnapshot: {
        ...releases(),
        capturedAt: "2026-07-25T13:00:00.000Z",
      },
    }, /GitHub Release snapshot version/],
  ]) {
    const providerSnapshot = provider();
    providerSnapshot.sources[source].version = fixture.at;
    assert.throws(() => join({ providerSnapshot, ...input }), message);
  }

  for (const [source, version, message] of [
    ["plane", "2026-07-25T11:00:00.000Z", /Plane snapshot version/],
    ["buildkite", "2026-07-25T11:00:00.000Z", /Buildkite snapshot version/],
    ["github", "2026-07-25T11:00:00.000Z", /GitHub Release snapshot version/],
  ]) {
    const snapshot = join();
    const providerObservation = snapshot.sources.provider.observations[0];
    providerObservation.evidence.sources[source].version = version;
    providerObservation.digest = digest(providerObservation.evidence);
    assert.throws(
      () => validateDeliveryEvidenceSnapshot(snapshot),
      message,
    );
  }
});

test("delivery join accepts release evidence older than a preserved source version", () => {
  const providerSnapshot = provider();
  providerSnapshot.capturedAt = "2026-07-25T13:00:00.000Z";
  providerSnapshot.sources.github.version = providerSnapshot.capturedAt;
  assert.doesNotThrow(() => join({ providerSnapshot }));
});

test("delivery join preserves valid opaque provider source versions", () => {
  const providerSnapshot = provider();
  providerSnapshot.sources.plane.version = "plane-scan-3000";
  providerSnapshot.sources.buildkite.version = "build-3000";
  providerSnapshot.sources.github.version = "release-scan-3000";
  assert.doesNotThrow(() => join({ providerSnapshot }));
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
  assert.equal(blocked.sources.deployment.observations.length, 1);
  assert.equal(
    blocked.sources.deployment.observations[0].evidence.reason,
    "Provider unavailable.",
  );
  assert.equal(blocked.deliveryRecords[0].deployment.status, "blocked");
  const failed = join({
    deploymentReceipts: [deployment({ status: "failed", deployedAt: null })],
    deploymentEnvironment: "production",
  });
  assert.equal(failed.deliveryRecords[0].deployment.status, "failed");
  assert.equal(failed.deliveryRecords[0].deployment.deployedAt, null);
});

test("delivery join preserves every unfinished Buildkite state", () => {
  for (const state of [
    "canceling",
    "creating",
    "failing",
    "running",
    "scheduled",
    "waiting",
    "waiting_failed",
  ]) {
    const snapshot = buildkite();
    snapshot.builds[0].state = state;
    snapshot.builds[0].finishedAt = null;
    assert.equal(
      join({ buildkiteSnapshots: [snapshot] }).deliveryRecords[0].ci.status,
      "in_progress",
      state,
    );
  }
});

test("delivery join selects the newest Buildkite build number", () => {
  const snapshot = buildkite();
  snapshot.builds = [
    {
      ...snapshot.builds[0],
      number: 6,
      createdAt: "2026-07-25T11:00:00.000Z",
      finishedAt: "2026-07-25T11:59:00.000Z",
      state: "passed",
    },
    {
      ...snapshot.builds[0],
      number: 7,
      createdAt: "2026-07-25T11:58:00.000Z",
      finishedAt: null,
      state: "running",
    },
  ];
  const joined = join({ buildkiteSnapshots: [snapshot] });
  const record = joined.deliveryRecords[0];
  assert.equal(record.ci.status, "in_progress");
  assert.equal(record.ci.buildNumber, 7);

  record.ci = {
    status: "passed",
    pipeline: "tabellio",
    buildNumber: 6,
    finishedAt: "2026-07-25T11:59:00.000Z",
    sourceClaimDigest: digest({
      pipeline: "tabellio",
      buildNumber: 6,
      commit: fixture.commit,
      status: "passed",
      finishedAt: "2026-07-25T11:59:00.000Z",
    }),
  };
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(joined),
    /do not match the validated source evidence/,
  );
});

test("delivery join honors blocked provider Buildkite evidence", () => {
  const providerSnapshot = provider();
  providerSnapshot.sources.buildkite = {
    status: "blocked",
    version: null,
    reason: "Buildkite unavailable.",
  };
  assert.throws(
    () => join({ providerSnapshot }),
    /Provider and Buildkite source availability mismatch/,
  );
  const snapshot = join({
    providerSnapshot,
    buildkiteSnapshots: [],
  });
  assert.equal(snapshot.sources.buildkite.status, "blocked");
  assert.equal(snapshot.deliveryRecords[0].ci.status, "blocked");
});

test("delivery join preserves blocked collector and unavailable provider Buildkite evidence", () => {
  const blockedCollector = buildkite();
  Object.assign(blockedCollector, {
    status: "blocked",
    reason: "Buildkite collector unavailable.",
    builds: [],
  });
  const blocked = join({ buildkiteSnapshots: [blockedCollector] });
  assert.equal(blocked.sources.buildkite.status, "blocked");
  assert.equal(blocked.deliveryRecords[0].ci.status, "blocked");

  const providerSnapshot = provider();
  providerSnapshot.sources.buildkite = {
    status: "unavailable",
    reason: "Buildkite is not configured.",
  };
  providerSnapshot.deliveryChanges[0].hostedStatus = "unavailable";
  const unavailable = join({
    providerSnapshot,
    buildkiteSnapshots: [],
  });
  assert.equal(unavailable.sources.buildkite.status, "unavailable");
  assert.equal(unavailable.deliveryRecords[0].ci.status, "unavailable");
});

test("delivery join preserves blocked Plane and release collector evidence", () => {
  const planeSnapshot = {
    ...plane(),
    status: "blocked",
    reason: "Plane collector unavailable.",
    projects: [],
    states: [],
    workItems: [],
  };
  const releaseSnapshot = {
    ...releases(),
    status: "blocked",
    reason: "GitHub collector unavailable.",
    releases: [],
  };
  const snapshot = join({ planeSnapshot, releaseSnapshot });
  assert.equal(snapshot.sources.plane.status, "blocked");
  assert.equal(snapshot.sources.plane.observations.length, 1);
  assert.equal(snapshot.sources.githubRelease.status, "blocked");
  assert.equal(snapshot.sources.githubRelease.observations.length, 1);
  assert.equal(snapshot.deliveryRecords[0].plane.status, "blocked");
  assert.equal(snapshot.deliveryRecords[0].release.status, "blocked");
});

test("delivery snapshot rejects Buildkite unavailable to blocked relabeling", () => {
  const snapshot = join({ buildkiteSnapshots: [] });
  snapshot.sources.buildkite.status = "blocked";
  snapshot.sources.buildkite.reason = "Buildkite evidence collection blocked.";
  snapshot.deliveryRecords[0].ci.status = "blocked";
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(snapshot),
    /Buildkite source state does not match provider and collector evidence/,
  );
});

test("delivery snapshot rejects deployment unavailable to blocked relabeling", () => {
  const snapshot = join({ deploymentEnvironment: "production" });
  snapshot.sources.deployment.status = "blocked";
  snapshot.sources.deployment.reason = "Deployment collector unavailable.";
  snapshot.deliveryRecords[0].deployment.status = "blocked";
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(snapshot),
    /Deployment source state does not match collection evidence/,
  );
});

test("delivery snapshot rejects provider source status relabeling without records", () => {
  const providerSnapshot = provider();
  providerSnapshot.deliveryChanges = [];
  const snapshot = join({ providerSnapshot });
  snapshot.sources.provider.status = "blocked";
  snapshot.sources.provider.reason = "Provider blocked.";
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(snapshot),
    /Provider source must remain available/,
  );
});

test("delivery snapshot rejects erasing available Plane and release observations", () => {
  for (const sourceName of ["plane", "githubRelease"]) {
    const snapshot = join();
    snapshot.sources[sourceName] = {
      status: "blocked",
      reason: "Collector unavailable.",
      observations: [],
    };
    if (sourceName === "plane") {
      snapshot.wipByProject = [];
      snapshot.deliveryRecords[0].plane = {
        status: "blocked",
        workspace: "intelip",
        key: "INTB-260",
        createdAt: null,
        stateGroup: null,
        updatedAt: null,
        sourceClaimDigest: null,
      };
    } else {
      snapshot.deliveryRecords[0].release = {
        status: "blocked",
        releaseId: null,
        tagName: null,
        publishedAt: null,
        commit: null,
        sourceClaimDigest: null,
      };
    }
    assert.throws(
      () => validateDeliveryEvidenceSnapshot(snapshot),
      /authority requires a validated/,
    );
  }
});

test("delivery join preserves maximum portable IDs and blocked reasons", () => {
  const providerSnapshot = provider();
  providerSnapshot.deliveryChanges[0].id = "a".repeat(200);
  const releaseSnapshot = {
    ...releases(),
    status: "blocked",
    reason: "x".repeat(500),
    releases: [],
  };
  const snapshot = join({ providerSnapshot, releaseSnapshot });
  assert.equal(snapshot.deliveryRecords[0].id.length, 200);
  assert.equal(snapshot.sources.githubRelease.reason.length, 500);
});

test("delivery join preserves blocked provider sources as blocked records", () => {
  const providerSnapshot = provider();
  providerSnapshot.sources.plane = {
    status: "blocked",
    version: null,
    reason: "Plane unavailable.",
    workspace: "intelip",
  };
  providerSnapshot.sources.github = {
    status: "blocked",
    version: null,
    reason: "GitHub unavailable.",
  };
  Object.assign(providerSnapshot.deliveryChanges[0], {
    linkBasis: "unlinked",
    planeStoryId: null,
    pullRequestNumber: null,
    storyCreatedAt: null,
    firstActivityAt: null,
    mergedAt: null,
    mergeCommit: null,
  });
  const planeSnapshot = {
    ...plane(),
    status: "blocked",
    reason: "Plane unavailable.",
    projects: [],
    states: [],
    workItems: [],
  };
  const releaseSnapshot = {
    ...releases(),
    status: "blocked",
    reason: "GitHub unavailable.",
    releases: [],
  };
  const snapshot = join({
    providerSnapshot,
    planeSnapshot,
    releaseSnapshot,
  });
  assert.equal(snapshot.sources.plane.status, "blocked");
  assert.equal(snapshot.deliveryRecords[0].plane.status, "blocked");
  assert.equal(snapshot.sources.githubRelease.status, "blocked");
  assert.equal(snapshot.deliveryRecords[0].release.status, "blocked");
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

test("delivery join scopes blocked collection to the target environment", () => {
  const snapshot = join({
    deploymentReceipts: [deployment({ environment: "staging" })],
    deploymentEnvironment: "production",
    deploymentBlockedReason: "Production collector unavailable.",
  });
  assert.equal(snapshot.sources.deployment.status, "blocked");
  assert.equal(
    snapshot.sources.deployment.reason,
    "Production collector unavailable.",
  );
  assert.equal(snapshot.deliveryRecords[0].deployment.status, "blocked");
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

test("delivery join preserves containment-linked release commits", () => {
  const mergeCommit = "b".repeat(40);
  const releaseCommit = "c".repeat(40);
  const providerSnapshot = provider();
  Object.assign(providerSnapshot.deliveryChanges[0], {
    mergeCommit,
    releasedAt: fixture.at,
    releaseCommit,
  });
  const releaseSnapshot = releases();
  releaseSnapshot.releases[0].commit = releaseCommit;
  const snapshot = join({ providerSnapshot, releaseSnapshot });
  assert.equal(snapshot.deliveryRecords[0].releaseCommit, releaseCommit);
  assert.equal(snapshot.deliveryRecords[0].release.status, "shipped");
  assert.equal(snapshot.deliveryRecords[0].release.commit, releaseCommit);
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
  const record = snapshot.deliveryRecords[0];
  Object.assign(record.release, {
    releaseId: "later",
    tagName: "v0.6.0",
    publishedAt: "2026-07-25T11:30:00.000Z",
  });
  record.release.sourceClaimDigest = digest({
    id: record.release.releaseId,
    tagName: record.release.tagName,
    publishedAt: record.release.publishedAt,
    commit: record.release.commit,
    commitStatus: "resolved",
  });
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(snapshot),
    /do not match the validated source evidence/,
  );
});

test("delivery join breaks equal release timestamps by release ID", () => {
  const releaseSnapshot = releases();
  releaseSnapshot.releases = [
    {
      ...releaseSnapshot.releases[0],
      id: "z-release",
      tagName: "v0.6.0",
    },
    {
      ...releaseSnapshot.releases[0],
      id: "a-release",
      tagName: "v0.5.0",
    },
  ];
  for (const rows of [
    releaseSnapshot.releases,
    releaseSnapshot.releases.toReversed(),
  ]) {
    const snapshot = join({
      releaseSnapshot: { ...releaseSnapshot, releases: rows },
    });
    assert.equal(snapshot.deliveryRecords[0].release.releaseId, "a-release");
  }
});

test("delivery join rejects provider release claims absent from source evidence", () => {
  const providerSnapshot = provider();
  providerSnapshot.deliveryChanges[0].releasedAt = fixture.at;
  providerSnapshot.deliveryChanges[0].releaseCommit = fixture.commit;
  const releaseSnapshot = releases();
  releaseSnapshot.releases = [];
  assert.throws(
    () => join({ providerSnapshot, releaseSnapshot }),
    /claims a release absent from source evidence/,
  );
});

test("delivery join rejects provider time that skips an earlier eligible release", () => {
  const providerSnapshot = provider();
  Object.assign(providerSnapshot.deliveryChanges[0], {
    storyCreatedAt: "2026-07-25T11:59:57.000Z",
    firstActivityAt: "2026-07-25T11:59:57.000Z",
    mergedAt: "2026-07-25T11:59:58.000Z",
    releasedAt: fixture.at,
    releaseCommit: fixture.commit,
  });
  const planeSnapshot = plane();
  planeSnapshot.workItems[0].createdAt =
    providerSnapshot.deliveryChanges[0].storyCreatedAt;
  const releaseSnapshot = releases();
  releaseSnapshot.releases.unshift({
    ...releaseSnapshot.releases[0],
    id: "earlier",
    tagName: "v0.4.9",
    publishedAt: "2026-07-25T11:59:59.000Z",
  });
  assert.throws(
    () => join({ providerSnapshot, planeSnapshot, releaseSnapshot }),
    /Conflicting GitHub release timestamp/,
  );
});

test("delivery join never ships an unmerged change", () => {
  const providerSnapshot = provider();
  providerSnapshot.deliveryChanges[0].mergedAt = null;
  providerSnapshot.deliveryChanges[0].mergeCommit = null;
  const snapshot = join({ providerSnapshot });
  assert.equal(snapshot.deliveryRecords[0].release.status, "unreleased");
});

test("delivery join never passes deployment before merge", () => {
  const providerSnapshot = provider();
  providerSnapshot.deliveryChanges[0].mergedAt = null;
  providerSnapshot.deliveryChanges[0].mergeCommit = null;
  const unmerged = join({
    providerSnapshot,
    deploymentReceipts: [deployment()],
    deploymentEnvironment: "production",
  });
  assert.equal(unmerged.deliveryRecords[0].deployment.status, "unavailable");

  const postMerge = provider();
  postMerge.deliveryChanges[0].mergedAt = "2026-07-25T12:00:00.000Z";
  const preMergeReceipt = deployment({
    deployedAt: "2026-07-25T11:59:59.000Z",
    observedAt: "2026-07-25T12:00:00.000Z",
  });
  const premature = join({
    providerSnapshot: postMerge,
    deploymentReceipts: [preMergeReceipt],
    deploymentEnvironment: "production",
  });
  assert.equal(premature.deliveryRecords[0].deployment.status, "unavailable");
});

test("delivery join preserves failed deployment attempts before merge", () => {
  const providerSnapshot = provider();
  providerSnapshot.deliveryChanges[0].mergedAt = null;
  providerSnapshot.deliveryChanges[0].mergeCommit = null;
  const snapshot = join({
    providerSnapshot,
    deploymentReceipts: [deployment({
      status: "failed",
      deployedAt: null,
    })],
    deploymentEnvironment: "production",
  });
  assert.equal(snapshot.deliveryRecords[0].deployment.status, "failed");
  assert.equal(snapshot.deliveryRecords[0].deployment.commit, fixture.commit);
});

test("delivery join rejects equal-time deployment receipt ambiguity", () => {
  assert.throws(
    () => join({
      deploymentReceipts: [
        deployment({ id: "passed-receipt" }),
        deployment({
          id: "failed-receipt",
          status: "failed",
          deployedAt: null,
        }),
      ],
      deploymentEnvironment: "production",
    }),
    /ambiguous latest deployment receipts/,
  );
});

test("delivery join ages WIP at Plane observation time", () => {
  const planeSnapshot = plane();
  planeSnapshot.capturedAt = "2026-07-22T12:00:00.000Z";
  planeSnapshot.workItems[0].createdAt = "2026-07-20T12:00:00.000Z";
  planeSnapshot.workItems[0].updatedAt = "2026-07-20T12:00:01.000Z";
  const providerSnapshot = provider();
  providerSnapshot.sources.plane.version = planeSnapshot.capturedAt;
  const snapshot = join({ providerSnapshot, planeSnapshot });
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
    /cannot be newer|capturedAt must match/,
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
    (record) => { record.releaseCommit = "b".repeat(40); },
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

test("delivery snapshot rejects imported cross-pipeline CI", () => {
  const snapshot = join();
  snapshot.ciAuthority.pipeline = "auxiliary";
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(snapshot),
    /designated Buildkite pipeline|designated authority|evidence authority/,
  );
});

test("delivery snapshot binds shipped releases to record commit and merge time", () => {
  const unrelated = join();
  const unrelatedRecord = unrelated.deliveryRecords[0];
  unrelatedRecord.release.commit = "b".repeat(40);
  unrelatedRecord.release.sourceClaimDigest = digest({
    id: unrelatedRecord.release.releaseId,
    tagName: unrelatedRecord.release.tagName,
    publishedAt: unrelatedRecord.release.publishedAt,
    commit: unrelatedRecord.release.commit,
    commitStatus: "resolved",
  });
  unrelated.sources.githubRelease.observations[0].claimDigests = [
    unrelatedRecord.release.sourceClaimDigest,
  ];
  unrelated.sources.githubRelease.observations[0].evidence.releases[0].commit =
    unrelatedRecord.release.commit;
  unrelated.sources.githubRelease.observations[0].digest = digest(
    unrelated.sources.githubRelease.observations[0].evidence,
  );
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(unrelated),
    /commit is not bound/,
  );

  const preMerge = join();
  const preMergeRecord = preMerge.deliveryRecords[0];
  preMergeRecord.release.publishedAt = "2026-07-25T11:59:59.000Z";
  preMergeRecord.release.sourceClaimDigest = digest({
    id: preMergeRecord.release.releaseId,
    tagName: preMergeRecord.release.tagName,
    publishedAt: preMergeRecord.release.publishedAt,
    commit: preMergeRecord.release.commit,
    commitStatus: "resolved",
  });
  preMerge.sources.githubRelease.observations[0].claimDigests = [
    preMergeRecord.release.sourceClaimDigest,
  ];
  preMerge.sources.githubRelease.observations[0].evidence.releases[0].publishedAt =
    preMergeRecord.release.publishedAt;
  preMerge.sources.githubRelease.observations[0].digest = digest(
    preMerge.sources.githubRelease.observations[0].evidence,
  );
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(preMerge),
    /predates the delivery record merge/,
  );
});

test("delivery snapshot rejects self-asserted claim digest rewrites", () => {
  const snapshot = join();
  const record = snapshot.deliveryRecords[0];
  record.ci.buildNumber = 999;
  record.ci.sourceClaimDigest = digest({
    pipeline: record.ci.pipeline,
    buildNumber: record.ci.buildNumber,
    commit: record.headCommit,
    status: record.ci.status,
    finishedAt: record.ci.finishedAt,
  });
  snapshot.sources.buildkite.observations[0].claimDigests = [
    record.ci.sourceClaimDigest,
  ];
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(snapshot),
    /source claims do not match its evidence/,
  );

  const tamperedEvidence = join();
  tamperedEvidence.sources.buildkite.observations[0].evidence.builds[0].number =
    999;
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(tamperedEvidence),
    /source digest does not match its evidence/,
  );

  const changedProviderStatus = join();
  const providerObservation =
    changedProviderStatus.sources.provider.observations[0];
  const providerChange = providerObservation.evidence.deliveryChanges[0];
  providerChange.validationStatus = "failed";
  providerObservation.digest = digest(providerObservation.evidence);
  providerObservation.claimDigests = [digest({
    id: providerChange.id,
    linkBasis: providerChange.linkBasis,
    pullRequestNumber: providerChange.pullRequestNumber,
    headCommit: providerChange.headCommit,
    mergeCommit: providerChange.mergeCommit,
    mergedAt: providerChange.mergedAt,
    releaseCommit: providerChange.releaseCommit,
    planeStoryId: providerChange.planeStoryId,
    validationStatus: providerChange.validationStatus,
    hostedStatus: providerChange.hostedStatus,
  })];
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(changedProviderStatus),
    /not bound to the provider observation/,
  );
});

test("delivery snapshot preserves blocked sources and portable receipt IDs", () => {
  const downgradedPlane = join();
  downgradedPlane.sources.plane = {
    status: "blocked",
    reason: "Plane unavailable.",
    observations: [],
  };
  downgradedPlane.deliveryRecords[0].plane.status = "unlinked";
  downgradedPlane.deliveryRecords[0].plane.sourceClaimDigest = null;
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(downgradedPlane),
    /must remain blocked/,
  );

  for (const receiptId of [
    "/Users/private/receipt.json",
    "file:receipt",
    "receipt\nforged",
    "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
  ]) {
    const snapshot = deployedSnapshot();
    snapshot.deliveryRecords[0].deployment.receiptId = receiptId;
    assert.throws(
      () => validateDeliveryEvidenceSnapshot(snapshot),
      /oneOf contract|prohibited contract|required pattern|exact receipt fields/,
    );
  }
});

test("delivery snapshot rejects record downgrades and forged WIP totals", () => {
  for (const mutate of [
    (record) => { record.plane.status = "unlinked"; },
    (record) => { record.ci.status = "in_progress"; },
    (record) => { record.release.status = "unreleased"; },
    (record) => { record.deployment.status = "unavailable"; },
  ]) {
    const snapshot = deployedSnapshot();
    mutate(snapshot.deliveryRecords[0]);
    assert.throws(
      () => validateDeliveryEvidenceSnapshot(snapshot),
      /do not match the validated source evidence/,
    );
  }
  const forgedWip = join();
  forgedWip.wipByProject[0] = {
    project: "INTB",
    activeItemCount: 0,
    aging3dCount: 0,
    overLimit: false,
  };
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(forgedWip),
    /WIP rows do not match the validated Plane evidence/,
  );
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

test("delivery snapshot rejects capturedAt freshness relabeling", () => {
  const snapshot = join({ buildkiteSnapshots: [] });
  snapshot.capturedAt = "2099-01-01T00:00:00.000Z";
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(snapshot),
    /capturedAt must match its newest source observation/,
  );
});

test("delivery join requires immutable Plane creation identity", () => {
  const planeSnapshot = plane();
  planeSnapshot.workItems[0].createdAt = "2026-07-25T11:59:59.000Z";
  assert.equal(
    join({ planeSnapshot }).deliveryRecords[0].plane.status,
    "unlinked",
  );
});

test("delivery join accepts collector-valid hyphenated Plane project keys", () => {
  const providerSnapshot = provider();
  providerSnapshot.deliveryChanges[0].planeStoryId = "INT-B-260";
  const planeSnapshot = plane();
  planeSnapshot.projects[0].identifier = "INT-B";
  const snapshot = join({ providerSnapshot, planeSnapshot });
  assert.equal(snapshot.wipByProject[0].project, "INT-B");
  assert.equal(snapshot.deliveryRecords[0].plane.key, "INT-B-260");
});

test("delivery snapshot rejects environment relabeling and shipment without merge identity", () => {
  const environment = join({
    deploymentReceipts: [deployment({ environment: "staging" })],
    deploymentEnvironment: "staging",
  });
  environment.deploymentEnvironment = "production";
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(environment),
    /Deployment source evidence authority mismatch/,
  );

  const providerSnapshot = provider();
  providerSnapshot.deliveryChanges[0].mergeCommit = null;
  const shipment = join({ providerSnapshot });
  assert.equal(shipment.deliveryRecords[0].release.status, "unreleased");
});

test("delivery join rejects partial blocked deployment collection", () => {
  assert.throws(
    () => join({
      deploymentReceipts: [deployment()],
      deploymentBlockedReason: "Deployment collection incomplete.",
      deploymentEnvironment: "production",
    }),
    /cannot include decisive receipts/,
  );
});

test("delivery join rejects malformed blocked deployment reasons", () => {
  for (const deploymentBlockedReason of ["", false, 0]) {
    assert.throws(
      () => join({
        deploymentBlockedReason,
        deploymentEnvironment: "production",
      }),
      /Deployment blocked reason is invalid/,
    );
  }
});

test("delivery snapshot rejects ambiguous authoritative observations", () => {
  const snapshot = join();
  snapshot.sources.plane.observations.push(
    structuredClone(snapshot.sources.plane.observations[0]),
  );
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(snapshot),
    /at most one authoritative observation/,
  );
});

test("delivery join preserves unavailable Plane and GitHub authority", () => {
  const providerSnapshot = provider();
  providerSnapshot.sources.plane = {
    status: "unavailable",
    reason: "Plane is not configured.",
    workspace: "intelip",
  };
  providerSnapshot.sources.github = {
    status: "unavailable",
    reason: "GitHub evidence is unavailable.",
  };
  Object.assign(providerSnapshot.deliveryChanges[0], {
    linkBasis: "unlinked",
    linkEvidence: null,
    planeStoryId: null,
    pullRequestNumber: null,
    storyCreatedAt: null,
    firstActivityAt: null,
    mergedAt: null,
    mergeCommit: null,
  });
  const planeSnapshot = {
    ...plane(),
    status: "blocked",
    reason: "Plane collector unavailable.",
    projects: [],
    states: [],
    workItems: [],
  };
  const releaseSnapshot = {
    ...releases(),
    status: "blocked",
    reason: "GitHub collector unavailable.",
    releases: [],
  };
  const snapshot = join({
    providerSnapshot,
    planeSnapshot,
    releaseSnapshot,
  });
  assert.equal(snapshot.sources.plane.status, "unavailable");
  assert.equal(snapshot.sources.githubRelease.status, "unavailable");
  assert.equal(snapshot.deliveryRecords[0].plane.status, "unavailable");
  assert.equal(snapshot.deliveryRecords[0].release.status, "unavailable");
});

test("delivery snapshot binds authority states and unique deployment receipts", () => {
  const blockedProvider = provider();
  blockedProvider.sources.plane = {
    status: "blocked",
    reason: "Plane unavailable.",
    workspace: "intelip",
  };
  Object.assign(blockedProvider.deliveryChanges[0], {
    linkBasis: "unlinked",
    linkEvidence: null,
    planeStoryId: null,
    pullRequestNumber: null,
    storyCreatedAt: null,
  });
  const blockedPlane = {
    ...plane(),
    status: "blocked",
    reason: "Plane unavailable.",
    projects: [],
    states: [],
    workItems: [],
  };
  const authority = join({
    providerSnapshot: blockedProvider,
    planeSnapshot: blockedPlane,
  });
  authority.sources.plane.status = "unavailable";
  assert.throws(
    () => validateDeliveryEvidenceSnapshot(authority),
    /does not match provider authority evidence|must remain unavailable/,
  );

  assert.throws(
    () => join({
      deploymentReceipts: [deployment(), deployment()],
      deploymentEnvironment: "production",
    }),
    /observation IDs must be unique/,
  );
});
