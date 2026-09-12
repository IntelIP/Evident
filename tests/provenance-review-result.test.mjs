import assert from "node:assert/strict";
import test from "node:test";
import { assembleLineage, candidateIdentity, evaluateLineage } from "../scripts/lib/provenance-ledger.mjs";
import { buildProvenanceReviewResult } from "../scripts/lib/provenance-review-result.mjs";
import { attachSecurityReview, runSecurityReview, SECURITY_CHECKS } from "../scripts/lib/provenance-security.mjs";
import { sampleObservations } from "../examples/provenance/sample.mjs";

const now = "2026-09-12T12:00:02Z";
const candidate = candidateIdentity({ projectKey: "SAMPLE", repositoryId: "github.com/example/tabellio", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), mergeBase: "a".repeat(40) });
function observations() {
  const replacements = { "pr-1": `${candidate.repositoryId}#9`, "build-1": "example/tabellio/12" };
  return sampleObservations(candidate).map((item) => ({ ...item, sourceId: replacements[item.sourceId] ?? item.sourceId, links: item.links.map((link) => ({ ...link, sourceId: replacements[link.sourceId] ?? link.sourceId })) }));
}
const lineage = (items = observations()) => assembleLineage({ candidate, observations: items });
const result = (input = lineage(), options = {}) => buildProvenanceReviewResult(input, { now, ...options });

test("CLI and GitHub preserve separate review/security verdicts and exact candidate", () => {
  const value = result();
  assert.equal(value.status, "passed");
  assert.equal(value.currentCandidate.id, candidate.id);
  assert.equal(value.security.detailsState, "not_loaded");
  assert.deepEqual(value.github.map((item) => item.state), ["success", "success"]);
  for (const item of value.github) {
    assert.equal(item.commit, candidate.headCommit);
    assert.ok(item.description.includes(candidate.id));
    assert.ok(item.description.length <= 140);
  }
  const failed = observations();
  failed.find((item) => item.kind === "review").status = "failed";
  const rejected = result(lineage(failed));
  assert.equal(rejected.status, "failed");
  assert.deepEqual(rejected.github.map((item) => item.state), ["failure", "success"]);
  assert.match(rejected.review.nextAction, /review findings/);
});

test("missing security never upgrades to a passed overall result", () => {
  const value = result(lineage(observations().filter((item) => item.kind !== "security")));
  assert.equal(value.status, "blocked");
  assert.equal(value.review.status, "passed");
  assert.equal(value.security.status, "blocked");
  assert.deepEqual(value.github.map((item) => item.state), ["success", "error"]);
  assert.match(value.security.nextAction, /security/);
});

test("stale head blocks both contexts and hides facts belonging to the old candidate", () => {
  const current = candidateIdentity({ ...candidate, headCommit: "c".repeat(40) });
  const value = result(lineage(), { candidate: current });
  assert.equal(value.status, "blocked");
  assert.deepEqual(value.evidence, []);
  assert.deepEqual(value.github.map((item) => item.state), ["error", "error"]);
  assert.ok(value.github.every((item) => item.commit === current.headCommit && item.description.includes(current.id)));
  assert.match(value.review.nextAction, /capture fresh evidence/);
  assert.equal(value.security.detailsState, "stale");
});

test("conflict and provider outage keep actionable source evidence visible", () => {
  const conflict = observations();
  conflict.push({ ...conflict[0], observedAt: "2026-09-12T12:00:01Z" });
  assert.equal(result(lineage(conflict)).status, "blocked");
  assert.match(result(lineage(conflict)).review.nextAction, /reconcile/);
  const outage = observations();
  Object.assign(outage.find((item) => item.kind === "validation"), { status: "blocked", metadata: { reason: "source_unavailable", summary: "private provider detail" } });
  const value = result(lineage(outage));
  assert.equal(value.status, "blocked");
  assert.equal(value.github[0].state, "error");
  assert.equal(value.github[0].targetUrl, "https://buildkite.com/example/tabellio/builds/12");
  assert.match(value.review.nextAction, /Restore source availability/);
  assert.ok(!JSON.stringify(value).includes("private provider detail"));
});

test("source links point to known records and report URLs reject credentials", () => {
  const value = result();
  assert.equal(value.evidence.find((item) => item.kind === "commit").url, `https://github.com/example/tabellio/commit/${candidate.headCommit}`);
  assert.equal(value.evidence.find((item) => item.kind === "pull_request").url, "https://github.com/example/tabellio/pull/9");
  assert.equal(value.evidence.find((item) => item.source === "plane").url, null);
  for (const reportUrl of ["javascript:alert(1)", "https://user:password@example.test/report", "https://example.test/report?token=private", "https://example.test/report#token%3Dprivate", "http://example.test/report"]) assert.throws(() => result(lineage(), { reportUrl }));
  const reportUrl = "https://example.test/reports/candidate";
  assert.ok(result(lineage(), { reportUrl }).github.every((item) => item.targetUrl === reportUrl));
});

test("verified security findings link to the reviewed file without source excerpts", async () => {
  const original = lineage(observations().filter((item) => item.kind !== "security"));
  const policyDigest = "d".repeat(64);
  const checks = Object.fromEntries(SECURITY_CHECKS.map((category) => [category, async (input) => ({ ...input, status: "passed", findings: category === "trust" ? [{ ruleId: "trust-disabled-tls", severity: "high", path: "src/app.mjs", line: 4, evidenceDigest: "e".repeat(64), snippet: "private source" }] : [] })]));
  const receipt = await runSecurityReview({ lineage: original, now, policyDigest, checks });
  const secured = attachSecurityReview({ lineage: original, review: receipt, policyDigest, now });
  const value = result(secured, { securityReceipt: receipt, policyDigest });
  assert.equal(value.status, evaluateLineage(secured, { now }).status);
  assert.equal(value.review.status, "passed");
  assert.equal(value.security.status, "failed");
  assert.equal(value.security.detailsState, "loaded");
  assert.equal(value.security.findings[0].url, `https://github.com/example/tabellio/blob/${candidate.headCommit}/src/app.mjs#L4`);
  assert.ok(!JSON.stringify(value).includes("private source"));
  assert.throws(() => result(secured, { securityReceipt: receipt, policyDigest: "f".repeat(64) }));
  assert.throws(() => result(secured, { securityReceipt: { ...receipt, status: "passed" }, policyDigest }));
});
