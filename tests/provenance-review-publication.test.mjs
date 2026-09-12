import assert from "node:assert/strict";
import test from "node:test";
import { createFeatureFixture } from "./helpers/git-fixture.mjs";
import { runGit } from "../scripts/lib/git-process.mjs";
import { assembleLineage, captureCandidate } from "../scripts/lib/provenance-ledger.mjs";
import { createProvenanceStatusIntent, publishProvenanceStatuses } from "../scripts/lib/provenance-review-publication.mjs";
import { sampleObservations } from "../examples/provenance/sample.mjs";
import { digestObject } from "../scripts/lib/stack-operation.mjs";

const now = "2026-09-12T12:00:02Z";
function approval(intent, id = "test-status") {
  return { schemaVersion: "tabellio-provenance-status-approval/v0.1", id, intentDigest: intent.integrity.digest, approved: true, approvedBy: "Synthetic test", approvedAt: now, expiresAt: "2026-09-12T12:01:02Z", reason: "Synthetic publisher only." };
}
async function setup(t, change = () => {}) {
  const fixture = await createFeatureFixture(t);
  const repo = fixture.seed;
  await runGit({ cwd: repo, args: ["remote", "set-url", "origin", "https://github.com/example/tabellio.git"] });
  const candidate = await captureCandidate({ repo, projectKey: "SAMPLE", repositoryId: "github.com/example/tabellio" });
  const observations = sampleObservations(candidate);
  change(observations);
  const lineage = assembleLineage({ candidate, observations });
  const intent = createProvenanceStatusIntent(lineage, { now });
  const calls = [];
  const publisher = { publish: async (request) => { calls.push(request); return { ...request, id: calls.length }; } };
  return { repo, lineage, intent, now, publisher, calls, approval: approval(intent) };
}

test("published GitHub statuses match the CLI intent and approval replay sends nothing", async (t) => {
  const input = await setup(t);
  const first = await publishProvenanceStatuses(input);
  assert.equal(first.status, "published");
  assert.deepEqual(input.calls, input.intent.statuses);
  assert.deepEqual(await publishProvenanceStatuses(input), first);
  assert.equal(input.calls.length, 2);
});

test("failed review and blocked security publish distinct non-green states", async (t) => {
  const input = await setup(t, (items) => {
    items.find((item) => item.kind === "review").status = "failed";
    items.find((item) => item.kind === "security").status = "blocked";
  });
  const receipt = await publishProvenanceStatuses(input);
  assert.equal(receipt.status, "published");
  assert.deepEqual(input.calls.map((item) => item.state), ["failure", "error"]);
});

test("expired approval, forged green state, and wrong origin are rejected before publication", async (t) => {
  const input = await setup(t, (items) => { items.find((item) => item.kind === "review").status = "failed"; });
  await assert.rejects(publishProvenanceStatuses({ ...input, now: "2026-09-12T12:02:00Z" }));
  const forged = structuredClone(input.intent);
  forged.statuses[0].state = "success";
  const { integrity: _integrity, ...unsigned } = forged;
  forged.integrity.digest = digestObject(unsigned);
  await assert.rejects(publishProvenanceStatuses({ ...input, intent: forged, approval: approval(forged) }));
  await runGit({ cwd: input.repo, args: ["remote", "set-url", "origin", "https://github.com/example/other.git"] });
  await assert.rejects(publishProvenanceStatuses(input));
  assert.equal(input.calls.length, 0);
});

test("changed head and stale evidence cannot publish an earlier green result", async (t) => {
  const input = await setup(t);
  const later = "2026-09-13T12:00:03Z";
  const active = { ...input.approval, approvedAt: later, expiresAt: "2026-09-13T12:01:03Z" };
  await assert.rejects(publishProvenanceStatuses({ ...input, approval: active, now: later }));
  await runGit({ cwd: input.repo, args: ["switch", "main"] });
  await assert.rejects(publishProvenanceStatuses(input));
  assert.equal(input.calls.length, 0);
});

test("partial provider failure stays blocked and consumed approval never retries", async (t) => {
  const input = await setup(t);
  let count = 0;
  input.publisher = { publish: async (request) => {
    count += 1;
    if (count === 2) throw new Error("private provider response");
    return { ...request, id: count };
  } };
  const receipt = await publishProvenanceStatuses(input);
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.published.length, 1);
  assert.ok(!JSON.stringify(receipt).includes("private provider response"));
  assert.deepEqual(await publishProvenanceStatuses(input), receipt);
  assert.equal(count, 2);
});

test("mismatched provider response cannot upgrade blocked evidence", async (t) => {
  const input = await setup(t, (items) => { items.find((item) => item.kind === "validation").status = "blocked"; });
  input.publisher = { publish: async (request) => ({ ...request, id: 1, state: "success" }) };
  const receipt = await publishProvenanceStatuses(input);
  assert.equal(receipt.status, "blocked");
  assert.deepEqual(receipt.published, []);
});

test("candidate movement between statuses stops the second publication", async (t) => {
  const input = await setup(t);
  let count = 0;
  input.publisher = { publish: async (request) => {
    count += 1;
    await runGit({ cwd: input.repo, args: ["switch", "main"] });
    return { ...request, id: count };
  } };
  const receipt = await publishProvenanceStatuses(input);
  assert.equal(receipt.status, "blocked");
  assert.equal(count, 1);
  assert.equal(receipt.published.length, 1);
});

test("concurrent consumers cannot publish twice under one approval", async (t) => {
  const input = await setup(t);
  const results = await Promise.allSettled([publishProvenanceStatuses(input), publishProvenanceStatuses(input)]);
  assert.ok(results.some((item) => item.status === "fulfilled" && item.value.status === "published"));
  assert.equal(input.calls.length, 2);
});
