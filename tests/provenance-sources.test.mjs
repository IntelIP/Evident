import assert from "node:assert/strict";
import test from "node:test";
import { candidateIdentity, evaluateLineage } from "../scripts/lib/provenance-ledger.mjs";
import { collectProvenanceSources } from "../scripts/lib/provenance-sources.mjs";
import { sampleSourceBundle } from "../examples/provenance/sources.mjs";

const now = "2026-07-10T12:00:02.000Z";
const candidate = candidateIdentity({ projectKey: "SAMPLE", repositoryId: "example/tabellio", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), mergeBase: "a".repeat(40) });
const selection = { taskId: "33333333-3333-4333-8333-333333333333", taskIdentifier: "SAMPLE-1", sessionId: "session-example", checkpointId: "abcdef123456", pullRequestNumber: 1, reviewId: "review-1", organization: "example", pipeline: "tabellio", buildNumber: 1, manifestDigest: "c".repeat(64) };
async function fixture() { return (await sampleSourceBundle(candidate, now)).snapshots; }
function collect(snapshots, overrides = {}) {
  const readers = Object.fromEntries(Object.entries(snapshots).map(([source, snapshot]) => [source, async () => snapshot]));
  return collectProvenanceSources({ candidate, selection, readers: { ...readers, ...overrides }, now });
}
test("five source fixtures normalize without claiming missing security review passed", async () => {
  const snapshots = await fixture();
  const result = await collect(snapshots);
  assert.deepEqual(result.sources.map(({ source, status }) => [source, status]), ["plane", "git", "entire", "github", "buildkite"].map((source) => [source, "present"]));
  assert.equal(result.lineage.observations.length, 7);
  assert.equal(evaluateLineage(result.lineage, { now }).status, "blocked");
  assert.deepEqual(await collect(snapshots), result);
});
test("provider bodies stay outside the normalized record", async () => {
  const snapshots = await fixture();
  snapshots.github.reviews[0].body += "\npassword=synthetic-private-value";
  snapshots.entire.checkpoints[0].summary = "private transcript fragment";
  const result = await collect(snapshots);
  assert.ok(result.sources.every((source) => source.status === "present"));
  const output = JSON.stringify(result);
  assert.ok(!output.includes("synthetic-private-value"));
  assert.ok(!output.includes("private transcript fragment"));
});
test("every unavailable reader yields a blocked source without retrying", async () => {
  const calls = [];
  const readers = Object.fromEntries(["plane", "git", "entire", "github", "buildkite"].map((source) => [source, async () => {
    calls.push(source);
    throw new Error("provider unavailable");
  }]));
  const result = await collectProvenanceSources({ candidate, selection, readers, now });
  assert.equal(calls.length, 5);
  assert.equal(new Set(calls).size, 5);
  assert.ok(result.sources.every((source) => source.status === "blocked"));
  assert.equal(evaluateLineage(result.lineage, { now }).status, "blocked");
});
test("failed builds and requested changes remain failures after normalization", async () => {
  for (const source of ["github", "buildkite"]) {
    const snapshots = await fixture();
    if (source === "github") snapshots.github.reviews[0].state = "changes_requested";
    else snapshots.buildkite.snapshot.builds[0].state = "failed";
    const result = await collect(snapshots);
    assert.equal(result.sources.find((item) => item.source === source).status, "present");
    assert.ok(result.lineage.observations.some((item) => item.source === source && item.status === "failed"));
    assert.equal(evaluateLineage(result.lineage, { now }).status, "failed");
  }
});
test("transport failures preserve healthy sources and redact raw errors", async () => {
  for (const [status, reason] of [[401, "authentication"], [403, "permission"], [404, "record_missing"], [503, "source_unavailable"]]) {
    const result = await collect(await fixture(), { plane: async () => { throw Object.assign(new Error("private-provider-body"), { status }); } });
    assert.equal(result.sources[0].reason, reason);
    assert.ok(result.sources.slice(1).every((source) => source.status === "present"));
    assert.ok(!JSON.stringify(result).includes("private-provider-body"));
  }
});
test("missing, malformed, mismatched, and unbound evidence fails closed", async () => {
  const cases = [
    ["plane", (x) => { x.plane.workItems = []; }, "record_missing"],
    ["entire", (x) => { x.entire = {}; }, "malformed_response"],
    ["git", (x) => { x.git.taskIdentifier = "OTHER-1"; }, "association_missing"],
    ["github", (x) => { x.github.repositoryId = "other/repo"; }, "scope_mismatch"],
    ["github", (x) => { x.github.changeRequest.source.commit = "d".repeat(40); }, "candidate_mismatch"],
    ["github", (x) => { x.github.reviews[0].body = "Approved"; }, "review_binding_missing"],
    ["buildkite", (x) => { delete x.buildkite.validation; }, "malformed_response"],
    ["buildkite", (x) => { x.buildkite.validation.integrity.digest = "d".repeat(64); }, "malformed_response"],
  ];
  for (const [source, mutate, reason] of cases) {
    const snapshots = await fixture();
    mutate(snapshots);
    const result = await collect(snapshots);
    assert.equal(result.sources.find((item) => item.source === source).reason, reason, source);
    assert.equal(evaluateLineage(result.lineage, { now }).status, "blocked");
  }
});
