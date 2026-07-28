import assert from "node:assert/strict";
import test from "node:test";

import { collectCloudRunDeploymentReceipt } from "../scripts/lib/cloud-run-deployment-collector.mjs";
import { collectVercelDeploymentReceipt } from "../scripts/lib/vercel-deployment-collector.mjs";

const COMMIT = "a".repeat(40);
const OBSERVED_AT = "2026-07-25T12:00:00.000Z";

test("Cloud Run collector proves a serving exact revision and full resource identity", async () => {
  const result = await cloudRunReceipt(cloudRunPayload());
  assert.equal(result.status, "available");
  assert.equal(result.receipt.commit, COMMIT);
  assert.match(
    result.receipt.provenancePointer,
    /projects\/intelip-prod\/locations\/us-east1/,
  );
});

test("Cloud Run collector blocks short commits, partial traffic, and wrong repositories", async () => {
  for (const payload of [
    cloudRunPayload({ commitSha: "a0bc228" }),
    cloudRunPayload({ percent: 50 }),
    cloudRunPayload({ repository: "IntelIP/Other" }),
    cloudRunPayload({
      traffic: [
        { percent: 100, revisionName: "agentos-00012" },
        { percent: 100, revisionName: "agentos-00011" },
      ],
    }),
  ]) {
    const result = await cloudRunReceipt(payload);
    assert.equal(result.status, "blocked");
    assert.equal(result.receipt, null);
  }
});

test("Cloud Run collector blocks impossible provider timestamps", async () => {
  const payload = cloudRunPayload();
  payload.revision.metadata.creationTimestamp = "2026-02-30T00:00:00.000Z";
  const result = await cloudRunReceipt(payload);
  assert.equal(result.status, "blocked");
  assert.equal(result.receipt, null);
});

test("Cloud Run collector keeps long resources inside the receipt ID contract", async () => {
  const result = await collectCloudRunDeploymentReceipt({
    repository: "IntelIP/Condere",
    environment: "production",
    service: `a${"b".repeat(61)}c`,
    project: `p${"1".repeat(62)}`,
    region: "us-east1",
    capturedAt: OBSERVED_AT,
    request: async () => cloudRunPayload({ revisionName: `r${"1".repeat(61)}x` }),
  });
  assert.equal(result.status, "available");
  assert(result.receipt.id.length <= 128);
  assert(result.receipt.externalId.length > result.receipt.id.length);
  console.log(`deployment_receipt_id_length=${result.receipt.id.length}`);
});

test("Vercel collector proves only repository-bound ready production deployments", async () => {
  const available = await vercelReceipt(vercelPayload());
  assert.equal(available.status, "available");
  assert.equal(available.receipt.deployedAt, "2026-07-25T11:00:00.000Z");
  for (const payload of [
    vercelPayload({ target: "preview" }),
    vercelPayload({ organization: "Other" }),
    vercelPayload({ commit: "abc123" }),
  ]) {
    const result = await vercelReceipt(payload);
    assert.equal(result.status, "blocked");
  }
});

test("deployment collectors capture observation time after provider reads", async () => {
  let read = false;
  const result = await collectVercelDeploymentReceipt({
    repository: "IntelIP/Vaticor",
    environment: "production",
    projectId: "prj_abc",
    clock: () => {
      assert.equal(read, true);
      return OBSERVED_AT;
    },
    request: async () => {
      read = true;
      return vercelPayload();
    },
  });
  assert.equal(result.status, "available");
  assert.equal(result.receipt.observedAt, OBSERVED_AT);
});

function cloudRunPayload({
  commitSha = COMMIT,
  repository = "IntelIP/Condere",
  percent = 100,
  revisionName = "agentos-00012",
  traffic = [{ percent, revisionName }],
} = {}) {
  return {
    service: { status: { traffic } },
    revision: {
      metadata: {
        name: revisionName,
        creationTimestamp: "2026-07-25T11:00:00.000Z",
        labels: { "commit-sha": commitSha },
        annotations: { "tabellio.dev/source-repository": repository },
      },
    },
  };
}

function cloudRunReceipt(payload) {
  return collectCloudRunDeploymentReceipt({
    repository: "IntelIP/Condere",
    environment: "production",
    service: "intelip-agentos-prod",
    project: "intelip-prod",
    region: "us-east1",
    capturedAt: OBSERVED_AT,
    request: async () => payload,
  });
}

function vercelPayload({
  target = "production",
  organization = "IntelIP",
  repository = "Vaticor",
  commit = COMMIT,
} = {}) {
  return {
    deployments: [{
      uid: "dpl_123",
      target,
      readyState: "READY",
      readyAt: Date.parse("2026-07-25T11:00:00.000Z"),
      meta: {
        githubCommitSha: commit,
        githubCommitOrg: organization,
        githubCommitRepo: repository,
      },
    }],
  };
}

function vercelReceipt(payload) {
  return collectVercelDeploymentReceipt({
    repository: "IntelIP/Vaticor",
    environment: "production",
    projectId: "prj_abc",
    capturedAt: OBSERVED_AT,
    request: async () => payload,
  });
}
