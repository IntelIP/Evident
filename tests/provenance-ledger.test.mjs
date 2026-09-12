import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { assembleLineage, buildReviewPacket, candidateIdentity, captureCandidate, evaluateLineage, verifyLineage } from "../scripts/lib/provenance-ledger.mjs";
import { sampleObservations } from "../examples/provenance/sample.mjs";

const execute = promisify(execFile);
const candidate = candidateIdentity({ projectKey: "SAMPLE", repositoryId: "sample/repository", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), mergeBase: "a".repeat(40) });
const now = "2026-09-12T12:00:01Z";
const input = () => ({ candidate, observations: sampleObservations(candidate) });

test("complete lineage is deterministic under reordered and duplicate input", () => {
  const a = assembleLineage(input());
  const b = input();
  b.observations.reverse();
  b.observations.push(b.observations[0]);
  assert.deepEqual(a, assembleLineage(b));
  assert.equal(evaluateLineage(a, { now }).status, "passed");
  assert.equal(buildReviewPacket(a, { now }).digest, buildReviewPacket(a, { now }).digest);
});

test("failure matrix blocks missing, stale, conflicting, inferred, failed, and disconnected evidence", () => {
  const cases = [
    ["missing", (x) => x.observations.splice(0, 1), "blocked"],
    ["stale", (x) => { x.observations[0].observedAt = "2026-08-01T00:00:00Z"; }, "blocked"],
    ["conflicting", (x) => { x.observations[2].candidate = { ...candidate, headCommit: "c".repeat(40) }; }, "blocked"],
    ["inferred", (x) => { x.observations[1].links[0].basis = "inferred"; }, "blocked"],
    ["failed", (x) => { x.observations[5].status = "failed"; }, "failed"],
    ["blocked", (x) => { x.observations[5].status = "blocked"; }, "blocked"],
    ["present validation", (x) => { x.observations[5].status = "present"; }, "blocked"],
    ["self-link", (x) => { x.observations[1].links[0] = { source: "entire", sourceId: "sample-run", relation: "supports", basis: "explicit" }; }, "blocked"],
    ["wrong predecessor", (x) => { x.observations[4].links[0] = { source: "plane", sourceId: "SAMPLE-1", relation: "supports", basis: "explicit" }; }, "blocked"],
    ["future timestamp", (x) => { x.observations[3].observedAt = "2027-01-01T00:00:00Z"; }, "blocked"],
    ["duplicate identity conflict", (x) => { x.observations.push({ ...x.observations[0], status: "blocked" }); }, "blocked"],
  ];
  for (const [name, mutate, status] of cases) {
    const altered = input();
    mutate(altered);
    const result = evaluateLineage(assembleLineage(altered), { now });
    assert.equal(result.status, status, name);
    assert.ok(result.reasons.length, name);
  }
});

test("candidate movement and tampering invalidate evidence", () => {
  const lineage = assembleLineage(input());
  for (const field of ["baseCommit", "headCommit", "mergeBase"]) {
    const changed = { ...candidate, [field]: "c".repeat(40) };
    assert.equal(evaluateLineage(lineage, { candidate: changed, now }).status, "blocked");
    const packet = buildReviewPacket(lineage, { candidate: changed, now });
    assert.equal(packet.candidate.id, candidateIdentity(changed).id);
    assert.equal(packet.facts.length, 0);
  }
  const tampered = structuredClone(lineage);
  tampered.observations[0].status = "failed";
  assert.throws(() => verifyLineage(tampered), /integrity/);
  assert.throws(() => candidateIdentity({ ...candidate, mergeBase: undefined }), /mergeBase/);
});

test("review packet excludes payloads and foreign candidate facts; credentials are rejected before hashing", () => {
  const data = input();
  data.observations[0].metadata = { note: "private internal note" };
  const foreign = { ...data.observations[0], sourceId: "OTHER-PRIVATE", candidate: { ...candidate, projectKey: "OTHER" } };
  data.observations.push(foreign);
  const packet = buildReviewPacket(assembleLineage(data), { now });
  const output = JSON.stringify(packet);
  assert.equal(packet.status, "blocked");
  assert.ok(!output.includes("private internal note"));
  assert.ok(!output.includes("OTHER-PRIVATE"));
  assert.ok(!output.includes('"projectKey":"OTHER"'));
  data.observations[0].metadata = { password: "synthetic-value" };
  assert.throws(() => assembleLineage(data), /forbidden/);
  data.observations[0].metadata = { note: "password=synthetic-value" };
  assert.throws(() => assembleLineage(data), /sensitive/);
  data.observations[0].metadata = { transcript: "private raw content" };
  assert.throws(() => assembleLineage(data), /forbidden/);
});

test("sample Git repository binds real base/head/merge-base and rejects moved base", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "tabellio-provenance-sample-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Sample", GIT_AUTHOR_EMAIL: "sample@example.invalid", GIT_COMMITTER_NAME: "Sample", GIT_COMMITTER_EMAIL: "sample@example.invalid" } });
  await git("init", "-b", "main");
  await writeFile(join(repo, "sample.txt"), "base\n");
  await git("add", "sample.txt");
  await git("commit", "-m", "Create sample baseline");
  await git("checkout", "-b", "sample-change");
  await writeFile(join(repo, "sample.txt"), "changed\n");
  await git("add", "sample.txt");
  await git("commit", "-m", "Change sample");
  const first = await captureCandidate({ repo, projectKey: "SAMPLE", repositoryId: "sample/repository" });
  assert.notEqual(first.baseCommit, first.headCommit);
  assert.equal(first.mergeBase, first.baseCommit);
  const lineage = assembleLineage({ candidate: first, observations: sampleObservations(first) });
  assert.equal(evaluateLineage(lineage, { now }).status, "passed");
  await git("branch", "-f", "main", first.headCommit);
  const moved = await captureCandidate({ repo, projectKey: "SAMPLE", repositoryId: "sample/repository" });
  assert.equal(evaluateLineage(lineage, { candidate: moved, now }).status, "blocked");
});
