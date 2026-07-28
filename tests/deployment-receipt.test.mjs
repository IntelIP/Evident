import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { extractDeploymentReceipts } from "../scripts/lib/deployment-receipt-input.mjs";
import { validateDeploymentReceipt } from "../scripts/lib/deployment-receipt.mjs";

const RECEIPT = {
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
  provenancePointer: "cloud-run:revision-123",
};

test("deployment receipt accepts bounded, repository-bound evidence", () => {
  assert.deepEqual(validateDeploymentReceipt(RECEIPT), RECEIPT);
});

test("deployment receipt requires exact keys, time order, and passed timestamp", () => {
  assert.throws(
    () => validateDeploymentReceipt({ ...RECEIPT, token: "private" }),
    /exactly/,
  );
  assert.throws(
    () => validateDeploymentReceipt({ ...RECEIPT, deployedAt: null }),
    /requires deployedAt/,
  );
  assert.throws(
    () => validateDeploymentReceipt({
      ...RECEIPT,
      observedAt: "2026-07-25T09:59:00.000Z",
    }),
    /cannot be after observedAt/,
  );
  assert.throws(
    () => validateDeploymentReceipt({
      ...RECEIPT,
      observedAt: "2026-02-30T00:00:00.000Z",
    }),
    /observedAt is invalid/,
  );
});

test("deployment receipt screens every exported identifier for credentials and paths", () => {
  for (const [field, value] of [
    ["id", "ghp_12345678"],
    ["repository", "github_pat_12345678/tabellio"],
    ["environment", "token=secret"],
    ["externalId", "ghs_12345678"],
    ["releaseTag", "gho_12345678"],
    ["provenancePointer", "file:/home/user/receipt.json"],
  ]) {
    assert.throws(
      () => validateDeploymentReceipt({ ...RECEIPT, [field]: value }),
      /invalid|unsafe portable provenance/,
      field,
    );
  }
});

test("deployment input preserves safe blocked collector evidence", () => {
  assert.deepEqual(extractDeploymentReceipts({
    status: "blocked",
    reason: "Provider unavailable.",
    receipt: null,
  }), {
    receipts: [],
    blockedReason: "Provider unavailable.",
  });
  assert.throws(
    () => extractDeploymentReceipts({
      status: "blocked",
      reason: "sk-proj_12345678",
      receipt: null,
    }),
    /must contain deployment receipts/,
  );
});

test("deployment schema restricts receipt identifiers and provenance pointers", async () => {
  const schema = JSON.parse(await readFile(
    "schemas/deployment-receipt.v0.1.schema.json",
    "utf8",
  ));
  assert.equal(
    schema.properties.id.allOf[1].pattern,
    "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
  );
  assert.match(schema.properties.repository.allOf[1].pattern, /\//);
  assert.match(
    schema.properties.provenancePointer.oneOf[1].allOf[1].pattern,
    /467/,
  );
  assert(schema.$defs.safeText.allOf.some(
    ({ not }) => not?.pattern.includes("[gG][hH][pPoOuUsSrR]_"),
  ));
  assert(schema.$defs.safeText.allOf.some(
    ({ not }) => not?.pattern.includes("[fF][iI][lL][eE]:"),
  ));
  assert.equal(schema.additionalProperties, false);
});
