import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateJsonSchema } from "../scripts/lib/json-schema-validator.mjs";
import { assembleLineage, candidateIdentity, evaluateLineage } from "../scripts/lib/provenance-ledger.mjs";
import { attachSecurityReview, runSecurityReview, SECURITY_CHECKS } from "../scripts/lib/provenance-security.mjs";
import { sampleObservations } from "../examples/provenance/sample.mjs";

const now = "2026-09-12T12:00:01Z";
const policyDigest = "c".repeat(64);
const candidate = candidateIdentity({ projectKey: "SAMPLE", repositoryId: "sample/repository", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), mergeBase: "a".repeat(40) });
const lineage = assembleLineage({ candidate, observations: sampleObservations(candidate).filter((item) => item.kind !== "security") });
// Reader fixtures test the evidence boundary, not scanner effectiveness.
const readers = () => Object.fromEntries(SECURITY_CHECKS.map((category) => [category, async ({ candidateId, packetDigest, policyDigest }) => ({ candidateId, packetDigest, policyDigest, status: "passed", findings: [] })]));
const run = (checks = readers(), overrides = {}) => runSecurityReview({ lineage, now, policyDigest, checks, ...overrides });
const attach = (review, overrides = {}) => attachSecurityReview({ lineage, review, policyDigest, now, ...overrides });
const evidence = () => ({ ruleId: "fixture-rule", severity: "high", path: "src/example.mjs", line: 3, evidenceDigest: "d".repeat(64) });

test("security requires four separate checks on the same safe candidate packet", async () => {
  assert.equal(evaluateLineage(lineage, { now }).status, "blocked");
  const calls = [];
  const checks = Object.fromEntries(SECURITY_CHECKS.map((category) => [category, async (input) => {
    calls.push(category);
    assert.equal(input.packet.candidate.id, candidate.id);
    assert.equal(input.packet.digest, input.packetDigest);
    assert.equal(input.packet.authoritative, false);
    assert.equal(input.packet.facts.some((item) => Object.hasOwn(item, "metadata")), false);
    return readers()[category](input);
  }]));
  const result = await run(checks);
  assert.deepEqual(calls, SECURITY_CHECKS);
  assert.equal(result.status, "passed");
  assert.equal(evaluateLineage(attach(result), { now }).status, "passed");
  assert.equal(lineage.observations.some((item) => item.kind === "security"), false);
});

test("missing, unavailable, malformed, and wrongly bound checks block security", async () => {
  for (const category of SECURITY_CHECKS) {
    for (const replacement of [undefined, async () => { throw new Error("private scanner failure"); }, async () => ({}), async (input) => ({ ...input, candidateId: "a".repeat(64), status: "passed", findings: [] })]) {
      const result = await run({ ...readers(), [category]: replacement });
      assert.equal(result.status, "blocked");
      assert.equal(evaluateLineage(attach(result), { now }).status, "blocked");
      assert.ok(!JSON.stringify(result).includes("private scanner failure"));
    }
  }
});

test("findings override a green scanner label and never export matched content", async () => {
  for (const category of SECURITY_CHECKS) {
    const result = await run({ ...readers(), [category]: async (input) => ({ ...input, status: "passed", findings: [{ ...evidence(), secret: "private-match", snippet: "private source", message: "private explanation" }] }) });
    assert.equal(result.status, "failed");
    assert.equal(evaluateLineage(attach(result), { now }).status, "failed");
    assert.ok(!JSON.stringify(result).includes("private"));
    assert.equal(result.checks.find((item) => item.category === category).findings[0].evidenceDigest, "d".repeat(64));
  }
});

test("unsafe findings are blocked without exporting their content", async () => {
  for (const update of [{ path: "../private" }, { path: "/private" }, { path: "password=private" }, { line: 0 }, { evidenceDigest: "bad" }, { severity: "unknown" }, { ruleId: "private text" }]) {
    const result = await run({ ...readers(), secrets: async (input) => ({ ...input, status: "failed", findings: [{ ...evidence(), ...update }] }) });
    assert.equal(result.status, "blocked");
    assert.ok(!JSON.stringify(result).includes("private"));
  }
});

test("security receipts reject tampering, changed policy, candidate, and packet", async () => {
  const result = await run();
  for (const mutate of [
    (value) => { value.status = "failed"; },
    (value) => { value.checks.pop(); },
    (value) => { value.checks.reverse(); },
    (value) => { value.checks[0].findings.push(evidence()); },
    (value) => { value.packetDigest = "d".repeat(64); },
    (value) => { value.candidate.headCommit = "e".repeat(40); },
    (value) => { value.private = "extra"; },
  ]) {
    const changed = structuredClone(result);
    mutate(changed);
    assert.throws(() => attach(changed));
  }
  assert.throws(() => attach(result, { policyDigest: "f".repeat(64) }));
  assert.throws(() => attach(result, { now: "2026-09-11T12:00:00Z" }));
  const changed = assembleLineage({ candidate, observations: lineage.observations.slice(1) });
  assert.throws(() => attach(result, { lineage: changed }));
});

test("checks cannot alter the packet another check receives", async () => {
  const result = await run({ ...readers(), secrets: async (input) => {
    input.packet.candidate.headCommit = "e".repeat(40);
    return readers().secrets(input);
  }, authorization: async (input) => {
    assert.equal(input.packet.candidate.headCommit, candidate.headCommit);
    return readers().authorization(input);
  } });
  assert.equal(result.status, "passed");
});

test("timed out checks abort and block without retrying or losing healthy checks", async () => {
  let calls = 0;
  let signal;
  const result = await run({ ...readers(), secrets: async (input) => {
    calls += 1;
    signal = input.signal;
    return new Promise(() => {});
  } }, { timeoutMs: 5 });
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  assert.equal(result.status, "blocked");
  assert.equal(result.checks.filter((item) => item.status === "passed").length, 3);
  await assert.rejects(run(readers(), { timeoutMs: 0 }));
});

test("security findings schema accepts producer results and rejects private or incomplete evidence", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/provenance-security-review.schema.json", import.meta.url), "utf8"));
  const failed = await run({ ...readers(), secrets: async (input) => ({ ...input, status: "failed", findings: [evidence()] }) });
  for (const value of [await run(), await run({}), failed]) assert.deepEqual(validateJsonSchema(value, schema), []);
  for (const mutate of [
    (value) => { value.checks.pop(); },
    (value) => { value.checks[0].findings[0].snippet = "private source"; },
    (value) => { value.checks[0].findings[0].severity = "unknown"; },
    (value) => { value.checks[0].findings[0].line = 0; },
    (value) => { value.observedAt = "2026-02-30T00:00:00Z"; },
    (value) => { value.candidate.headCommit = "main"; },
  ]) {
    const value = structuredClone(failed);
    mutate(value);
    assert.notDeepEqual(validateJsonSchema(value, schema), []);
  }
});
