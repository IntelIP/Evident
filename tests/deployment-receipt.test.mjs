import assert from "node:assert/strict";
import test from "node:test";
import { extractDeploymentReceipts } from "../scripts/lib/deployment-receipt-input.mjs";

import { validateDeploymentReceipt } from "../scripts/lib/deployment-receipt.mjs";

const receipt = {
  schemaVersion: "tabellio-deployment-receipt/v0.1",
  id: "deploy-1",
  repository: "intelip/tabellio",
  environment: "production",
  commit: "a".repeat(40),
  status: "passed",
  deployedAt: "2026-07-25T10:00:00.000Z",
  observedAt: "2026-07-25T10:01:00.000Z",
  provider: "cloud-run",
  externalId: "revision-123",
  releaseTag: "v0.6.0",
  provenancePointer: "cloud-run:revision-123"
};

test("deployment receipt accepts bounded, provenance-safe evidence", () => {
  assert.deepEqual(validateDeploymentReceipt(receipt), receipt);
});

test("passed deployment requires a deployment timestamp", () => {
  assert.throws(() => validateDeploymentReceipt({ ...receipt, deployedAt: null }), /requires deployedAt/);
});

test("deployment cannot be observed before it occurred", () => {
  assert.throws(() => validateDeploymentReceipt({
    ...receipt,
    observedAt: "2026-07-25T09:59:00.000Z"
  }), /cannot be after observedAt/);
});

test("receipt rejects secrets and unknown fields", () => {
  assert.throws(() => validateDeploymentReceipt({ ...receipt, token: "private" }), /Invalid deployment receipt/);
});

test("receipt rejects credentialed and local provenance pointers", () => {
  assert.throws(() => validateDeploymentReceipt({ ...receipt, provenancePointer: "https://user:secret@example.test/deploy" }), /Invalid deployment receipt|unsafe portable provenance/);
  assert.throws(() => validateDeploymentReceipt({ ...receipt, provenancePointer: "file:///home/user/receipt.json" }), /Invalid deployment receipt|unsafe portable provenance/);
});

test("deployment receipt input normalizes supported collector shapes", () => {
  assert.deepEqual(extractDeploymentReceipts([receipt]), [receipt]);
  assert.deepEqual(extractDeploymentReceipts({ status: "available", receipt }), [receipt]);
  assert.deepEqual(extractDeploymentReceipts(receipt), [receipt]);
  assert.throws(() => extractDeploymentReceipts({ status: "blocked" }), /must contain deployment receipts/);
});
