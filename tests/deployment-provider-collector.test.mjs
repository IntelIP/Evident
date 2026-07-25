import assert from "node:assert/strict";
import test from "node:test";
import { collectCloudRunDeploymentReceipt } from "../scripts/lib/cloud-run-deployment-collector.mjs";
import { collectVercelDeploymentReceipt } from "../scripts/lib/vercel-deployment-collector.mjs";

const commit = "a".repeat(40); const at = "2026-07-25T12:00:00.000Z";
test("Cloud Run collector proves only a fully-serving exact revision", async () => {
  const result = await collectCloudRunDeploymentReceipt({ repository: "IntelIP/Condere", environment: "production", service: "intelip-agentos-prod", capturedAt: at, request: async () => ({ service: { status: { traffic: [{ percent: 100, revisionName: "agentos-00012" }] } }, revision: { metadata: { name: "agentos-00012", creationTimestamp: "2026-07-25T11:00:00.000Z", labels: { "commit-sha": commit } } } }) });
  assert.equal(result.status, "available"); assert.equal(result.receipt.provider, "cloud-run"); assert.equal(result.receipt.commit, commit);
});
test("Cloud Run collector blocks short commit labels", async () => {
  const result = await collectCloudRunDeploymentReceipt({ repository: "IntelIP/Condere", environment: "production", service: "intelip-agentos-prod", capturedAt: at, request: async () => ({ service: { status: { traffic: [{ percent: 100, revisionName: "agentos-00012" }] } }, revision: { metadata: { name: "agentos-00012", creationTimestamp: "2026-07-25T11:00:00.000Z", labels: { "commit-sha": "a0bc228" } } } }) });
  assert.deepEqual(result, { status: "blocked", reason: "Cloud Run runtime receipt unavailable or lacks an exact commit.", receipt: null });
});
test("Cloud Run collector blocks a revision without all serving traffic", async () => {
  const result = await collectCloudRunDeploymentReceipt({ repository: "IntelIP/Condere", environment: "production", service: "intelip-agentos-prod", capturedAt: at, request: async () => ({ service: { status: { traffic: [{ percent: 50, revisionName: "agentos-00012" }] } }, revision: { metadata: { name: "agentos-00012", creationTimestamp: "2026-07-25T11:00:00.000Z", labels: { "commit-sha": commit } } } }) });
  assert.equal(result.status, "blocked");
});
test("Vercel collector proves a ready production deployment with exact commit", async () => {
  const result = await collectVercelDeploymentReceipt({ repository: "IntelIP/vaticor", environment: "production", projectId: "prj_abc", capturedAt: at, request: async () => ({ deployments: [{ uid: "dpl_123", target: "production", readyState: "READY", readyAt: Date.parse("2026-07-25T11:00:00.000Z"), meta: { githubCommitSha: commit } }] }) });
  assert.equal(result.status, "available"); assert.equal(result.receipt.provider, "vercel"); assert.equal(result.receipt.deployedAt, "2026-07-25T11:00:00.000Z");
});
test("Vercel collector ignores preview and unpinned deployments", async () => {
  const result = await collectVercelDeploymentReceipt({ repository: "IntelIP/vaticor", environment: "production", projectId: "prj_abc", capturedAt: at, request: async () => ({ deployments: [{ uid: "dpl_123", target: "preview", readyState: "READY", readyAt: Date.parse("2026-07-25T11:00:00.000Z"), meta: { githubCommitSha: commit } }] }) });
  assert.equal(result.status, "blocked"); assert.equal(result.receipt, null);
});
