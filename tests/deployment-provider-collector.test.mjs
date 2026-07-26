import assert from "node:assert/strict";
import test from "node:test";
import { collectCloudRunDeploymentReceipt } from "../scripts/lib/cloud-run-deployment-collector.mjs";
import { collectVercelDeploymentReceipt } from "../scripts/lib/vercel-deployment-collector.mjs";

const commit = "a".repeat(40); const at = "2026-07-25T12:00:00.000Z";
test("Cloud Run collector proves only a fully-serving exact revision", async () => {
  const result = await cloudRunReceipt(cloudRunPayload());
  assert.equal(result.status, "available"); assert.equal(result.receipt.provider, "cloud-run"); assert.equal(result.receipt.commit, commit); assert.match(result.receipt.provenancePointer,/projects\/intelip-prod\/locations\/us-east1/);
});
test("Cloud Run collector blocks short commit labels", async () => {
  const result = await cloudRunReceipt(cloudRunPayload({ commitSha: "a0bc228" }));
  assert.deepEqual(result, { status: "blocked", reason: "Cloud Run runtime receipt unavailable or lacks an exact commit.", receipt: null });
});
test("Cloud Run collector blocks a revision without all serving traffic", async () => {
  const result = await cloudRunReceipt(cloudRunPayload({ percent: 50 }));
  assert.equal(result.status, "blocked");
});
test("Cloud Run collector rejects a revision from another repository", async () => {
  const result = await cloudRunReceipt(cloudRunPayload({ repository: "IntelIP/Other" }));
  assert.equal(result.status, "blocked"); assert.equal(result.receipt, null);
});
test("Cloud Run collector keeps long resource names inside the receipt ID contract", async () => {
  const service = `a${"b".repeat(61)}c`;
  const project = `p${"1".repeat(62)}`;
  const revisionName = `${"r".repeat(63)}`;
  const result = await collectCloudRunDeploymentReceipt({
    repository: "IntelIP/Condere",
    environment: "production",
    service,
    project,
    region: "us-east1",
    capturedAt: at,
    request: async () => cloudRunPayload({ revisionName }),
  });
  assert.equal(result.status, "available");
  assert(result.receipt.id.length <= 128);
  assert(result.receipt.externalId.length > result.receipt.id.length);
});
test("Vercel collector proves a ready production deployment with exact commit", async () => {
  const result = await collectVercelDeploymentReceipt({ repository: "IntelIP/vaticor", environment: "production", projectId: "prj_abc", capturedAt: at, request: async () => ({ deployments: [{ uid: "dpl_123", target: "production", readyState: "READY", readyAt: Date.parse("2026-07-25T11:00:00.000Z"), meta: { githubCommitSha: commit, githubCommitOrg: "IntelIP", githubCommitRepo: "vaticor" } }] }) });
  assert.equal(result.status, "available"); assert.equal(result.receipt.provider, "vercel"); assert.equal(result.receipt.deployedAt, "2026-07-25T11:00:00.000Z");
});
test("Vercel collector ignores preview and unpinned deployments", async () => {
  const result = await collectVercelDeploymentReceipt({ repository: "IntelIP/vaticor", environment: "production", projectId: "prj_abc", capturedAt: at, request: async () => ({ deployments: [{ uid: "dpl_123", target: "preview", readyState: "READY", readyAt: Date.parse("2026-07-25T11:00:00.000Z"), meta: { githubCommitSha: commit, githubCommitOrg: "IntelIP", githubCommitRepo: "vaticor" } }] }) });
  assert.equal(result.status, "blocked"); assert.equal(result.receipt, null);
});
test("Vercel collector rejects a deployment from another repository", async () => {
  const result = await collectVercelDeploymentReceipt({ repository: "IntelIP/vaticor", environment: "production", projectId: "prj_abc", capturedAt: at, request: async () => ({ deployments: [{ uid: "dpl_123", target: "production", readyState: "READY", readyAt: Date.parse("2026-07-25T11:00:00.000Z"), meta: { githubCommitSha: commit, githubCommitOrg: "Other", githubCommitRepo: "vaticor" } }] }) });
  assert.equal(result.status, "blocked"); assert.equal(result.receipt, null);
});
function cloudRunPayload({ commitSha = commit, repository = "IntelIP/Condere", percent = 100, revisionName = "agentos-00012" } = {}) {
  return {
    service: { status: { traffic: [{ percent, revisionName }] } },
    revision: { metadata: { name: revisionName, creationTimestamp: "2026-07-25T11:00:00.000Z", labels: { "commit-sha": commitSha }, annotations: { "tabellio.dev/source-repository": repository } } },
  };
}
function cloudRunReceipt(payload) {
  return collectCloudRunDeploymentReceipt({ repository: "IntelIP/Condere", environment: "production", service: "intelip-agentos-prod", project: "intelip-prod", region: "us-east1", capturedAt: at, request: async () => payload });
}
