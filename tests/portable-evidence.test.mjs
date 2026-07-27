import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalRepositoryId,
  hasCredentialShape,
  isPortableIdentifier,
  sameRepository,
  validateEvidenceBinding,
  validateEvidenceSource,
  validateProviderSnapshot,
} from "../scripts/lib/portable-evidence.mjs";

const HEAD = "a".repeat(40);
const OBSERVED_AT = "2026-07-27T00:00:00.000Z";

test("portable identifiers reject paths, control text, and credential shapes", () => {
  for (const value of ["/tmp/private", "C:\\private", "file:///private", "owner\\repo", "a|b", "a\n b", "ghp_0123456789abcdef"]) {
    assert.equal(isPortableIdentifier(value), false, value);
  }
  assert.equal(isPortableIdentifier("INTB-261"), true);
  assert.equal(hasCredentialShape("github_pat_0123456789abcdef"), true);
  assert.equal(hasCredentialShape("sk-proj-0123456789abcdef"), true);
  assert.equal(hasCredentialShape("https://alice:secret@example.com/repo"), true);
});

test("repository identity is strict and never strips credentials", () => {
  assert.equal(canonicalRepositoryId("IntelIP/Tabellio"), "intelip/tabellio");
  assert.equal(sameRepository("IntelIP/Tabellio", "intelip/tabellio"), true);
  assert.equal(canonicalRepositoryId("https://token@github.com/IntelIP/Tabellio.git"), null);
  assert.equal(sameRepository("IntelIP/Tabellio", "https://token@github.com/IntelIP/Tabellio.git"), false);
});

test("source contracts require exact state shapes and safe evidence", () => {
  assert.deepEqual(validateEvidenceSource({ status: "available", version: "2026-07-26T00:00:00.000Z" }, { observedAt: OBSERVED_AT }), []);
  assert.match(validateEvidenceSource({ status: "available", version: null })[0], /requires a safe version/);
  assert.match(validateEvidenceSource({ status: "available", version: "ghp_0123456789abcdef" })[0], /unsafe/);
  assert.match(validateEvidenceSource({ status: "blocked", reason: "/tmp/private" })[0], /safe reason/);
  assert.match(validateEvidenceSource({ status: "blocked", reason: "provider error: path=/Users/alice/private" })[0], /safe reason/);
  assert.match(validateEvidenceSource({ status: "blocked", reason: "ENOENT (/home/alice/private)" })[0], /safe reason/);
  assert.match(validateEvidenceSource({ status: "blocked", reason: "ENOENT '/home/alice/private'" })[0], /safe reason/);
  assert.match(validateEvidenceSource({ status: "blocked", reason: "failed [/var/lib/private]" })[0], /safe reason/);
  assert.match(validateEvidenceSource({ status: "blocked", reason: "provider error: C:/Users/alice/private" })[0], /safe reason/);
  assert.match(validateEvidenceSource({ status: "blocked", reason: "https://token@github.com/IntelIP/Tabellio" })[0], /safe reason/);
  assert.match(validateEvidenceSource({ status: "unavailable", reason: "offline", workspace: "private" })[0], /not allowed/);
  assert.match(validateEvidenceSource({ status: "unavailable", reason: "offline", version: "2026-07-25T00:00:00.000Z" }).join(" "), /cannot carry a version/);
  assert.deepEqual(validateEvidenceSource({ status: "unavailable", reason: "offline", ghp_0123456789abcdef: true }), ["source contains a field that is not allowed"]);
  assert.match(validateEvidenceSource({ status: "available", version: "2099-01-01T00:00:00.000Z" }, { observedAt: OBSERVED_AT }).join(" "), /later than observation/);
});

test("evidence binding requires canonical repository and exact head", () => {
  assert.deepEqual(validateEvidenceBinding({
    repository: "IntelIP/Tabellio",
    sourceRepository: "intelip/tabellio",
    headCommit: HEAD,
    sourceHeadCommit: HEAD,
  }), []);
  assert.match(validateEvidenceBinding({
    repository: "IntelIP/Tabellio",
    sourceRepository: "IntelIP/Other",
    headCommit: HEAD,
    sourceHeadCommit: "b".repeat(40),
  }).join(" "), /repository binding.*head binding/);
  assert.match(validateEvidenceBinding({
    repository: "IntelIP/Tabellio",
    sourceRepository: "IntelIP/Tabellio",
    headCommit: HEAD,
    sourceHeadCommit: "a".repeat(64),
  }).join(" "), /head binding/);
});

test("provider snapshot accepts a minimal portable exact-head record", () => {
  assert.deepEqual(validateProviderSnapshot(snapshot(), {
    repository: "IntelIP/Tabellio",
    headCommit: HEAD,
    observedAt: OBSERVED_AT,
  }), []);
});

test("provider snapshot accepts Buildkite as hosted evidence", () => {
  const value = snapshot();
  value.sources["github-actions"] = { status: "unavailable", reason: "not configured" };
  assert.deepEqual(validateProviderSnapshot(value, {
    repository: "IntelIP/Tabellio",
    headCommit: HEAD,
    observedAt: OBSERVED_AT,
  }), []);
});

test("provider snapshot rejects unsafe and contradictory claims", () => {
  const cases = [
    ["unknown field", (value) => { value.privatePayload = "secret"; }, /not allowed/],
    ["credentialed repository", (value) => { value.repository = "https://x:secret@github.com/IntelIP/Tabellio.git"; }, /repository/],
    ["wrong snapshot head", (value) => { value.headCommit = "b".repeat(40); }, /headCommit/],
    ["sha256 snapshot head", (value) => { value.headCommit = "b".repeat(64); }, /headCommit/],
    ["empty snapshot wrong head", (value) => { value.deliveryChanges = []; value.headCommit = "b".repeat(40); }, /headCommit/],
    ["future capture", (value) => { value.capturedAt = "2099-01-01T00:00:00.000Z"; }, /later than observation/],
    ["normalized capture", (value) => { value.capturedAt = "2026-02-30T00:00:00.000Z"; }, /capturedAt is invalid/],
    ["missing source", (value) => { delete value.sources.github; }, /github is missing/],
    ["unknown source", (value) => { value.sources.raw = { status: "available", version: "v1" }; }, /not allowed/],
    ["bad head", (value) => { value.deliveryChanges[0].headCommit = "bad"; }, /headCommit/],
    ["future lifecycle", (value) => { value.deliveryChanges[0].mergedAt = "2099-01-01T00:00:00.000Z"; }, /later than capture/],
    ["reversed lifecycle", (value) => { value.deliveryChanges[0].firstActivityAt = "2026-07-24T00:00:00.000Z"; }, /later than mergedAt/],
    ["unlinked relation", (value) => { value.deliveryChanges[0].linkBasis = "unlinked"; }, /requires null relationship/],
    ["source contradiction", (value) => { value.sources.plane = { status: "blocked", reason: "offline" }; }, /requires available Plane/],
    ["unavailable lifecycle source", (value) => { value.deliveryChanges[0].linkBasis = "unlinked"; value.deliveryChanges[0].linkEvidence = null; value.deliveryChanges[0].planeStoryId = null; value.deliveryChanges[0].pullRequestNumber = null; value.sources.plane = { status: "unavailable", reason: "offline" }; }, /storyCreatedAt requires available Plane/],
    ["credentialed link evidence", (value) => { value.deliveryChanges[0].linkEvidence = "https://token@github.com/IntelIP/Tabellio"; }, /linkEvidence is unsafe/],
    ["skipped lifecycle order", (value) => { value.deliveryChanges[0].firstActivityAt = null; value.deliveryChanges[0].storyCreatedAt = "2026-07-23T00:00:00.000Z"; }, /storyCreatedAt is later than mergedAt/],
    ["unsafe pull request number", (value) => { value.deliveryChanges[0].pullRequestNumber = Number.MAX_SAFE_INTEGER + 1; }, /linked change requires Plane/],
    ["duplicate delivery change", (value) => { value.deliveryChanges.push(structuredClone(value.deliveryChanges[0])); }, /duplicates delivery change id/],
    ["duplicate relationship", (value) => { const duplicate = structuredClone(value.deliveryChanges[0]); duplicate.id = "change-2"; value.deliveryChanges.push(duplicate); }, /duplicates Plane and pull-request relationship/],
    ["unicode control", (value) => { value.deliveryChanges[0].linkEvidence = "safe\u2028text"; }, /linkEvidence is unsafe/],
    ["extra change payload", (value) => { value.deliveryChanges[0].raw = "private"; }, /not allowed/],
  ];
  for (const [name, mutate, expected] of cases) {
    const value = snapshot();
    mutate(value);
    assert.match(validateProviderSnapshot(value, {
      repository: "IntelIP/Tabellio",
      headCommit: HEAD,
      observedAt: OBSERVED_AT,
    }).join(" "), expected, name);
  }
});

function snapshot() {
  return {
    schemaVersion: "tabellio-analytics-provider-snapshot/v0.1",
    repository: "IntelIP/Tabellio",
    headCommit: HEAD,
    capturedAt: "2026-07-26T00:00:00.000Z",
    sources: {
      plane: { status: "available", version: "2026-07-25T00:00:00.000Z" },
      github: { status: "available", version: "2026-07-25T00:00:00.000Z" },
      "github-actions": { status: "available", version: "2026-07-25T00:00:00.000Z" },
      buildkite: { status: "available", version: "2026-07-25T00:00:00.000Z" },
    },
    deliveryChanges: [{
      id: "change-1",
      linkBasis: "explicit",
      linkEvidence: "Plane PR binding",
      planeStoryId: "INTB-261",
      pullRequestNumber: 28,
      storyCreatedAt: "2026-07-20T00:00:00.000Z",
      firstActivityAt: "2026-07-21T00:00:00.000Z",
      mergedAt: "2026-07-22T00:00:00.000Z",
      headCommit: HEAD,
      validationStatus: "passed",
      hostedStatus: "passed",
    }],
  };
}
