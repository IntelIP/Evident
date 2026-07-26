import assert from "node:assert/strict";
import test from "node:test";
import { collectBuildkiteBuildSnapshot } from "../scripts/lib/buildkite-build-collector.mjs";
const at = "2026-07-25T12:00:00.000Z"; const commit = "a".repeat(40);
test("Buildkite collector preserves exact build evidence", async () => {
  const snapshot = await collectBuildkiteBuildSnapshot({ repository: "IntelIP/Tabellio", organization: "intelip", pipeline: "tabellio", capturedAt: at, request: async (path) => path.endsWith("/pipelines/tabellio") ? { repository: "https://github.com/IntelIP/Tabellio.git" } : path.includes("/builds?") ? [{ number: 4, commit, state: "passed", created_at: "2026-07-25T11:00:00.000Z", finished_at: "2026-07-25T11:02:00.000Z" }] : path.includes("/jobs?") ? { items: [{ id: "job-1" }], links: { next: null } } : [{ id: "artifact-1" }, { id: "artifact-2" }] });
  assert.equal(snapshot.status, "available"); assert.deepEqual(snapshot.builds[0], { number: 4, commit, state: "passed", createdAt: "2026-07-25T11:00:00.000Z", finishedAt: "2026-07-25T11:02:00.000Z", jobCount: 1, artifactCount: 2 });
});
test("Buildkite collector blocks safely without error leakage", async () => {
  const snapshot = await collectBuildkiteBuildSnapshot({ repository: "IntelIP/Tabellio", organization: "intelip", pipeline: "tabellio", capturedAt: at, request: async () => { throw new Error("token=x"); } });
  assert.equal(snapshot.status, "blocked"); assert.equal(snapshot.reason, "Buildkite build collection unavailable.");
});
test("Buildkite collector blocks a pipeline bound to another repository", async () => {
  const snapshot = await collectBuildkiteBuildSnapshot({ repository: "IntelIP/Tabellio", organization: "intelip", pipeline: "tabellio", capturedAt: at, request: async () => ({ repository: "https://github.com/IntelIP/Other.git" }) });
  assert.equal(snapshot.status, "blocked");
});
test("Buildkite snapshot rejects duplicate builds and post-capture timestamps", async () => {
  const base = { schemaVersion: "tabellio-buildkite-build-snapshot/v0.1", repository: "IntelIP/Tabellio", organization: "intelip", pipeline: "tabellio", capturedAt: at, status: "available", reason: null, builds: [{ number: 4, commit, state: "passed", createdAt: "2026-07-25T11:00:00.000Z", finishedAt: "2026-07-25T11:02:00.000Z", jobCount: 1, artifactCount: 2 }] };
  const { validateBuildkiteBuildSnapshot } = await import("../scripts/lib/buildkite-build-collector.mjs");
  assert.throws(() => validateBuildkiteBuildSnapshot({ ...base, builds: [base.builds[0], base.builds[0]] }), /build numbers must be unique/);
  assert.throws(() => validateBuildkiteBuildSnapshot({ ...base, builds: [{ ...base.builds[0], finishedAt: "2026-07-25T12:00:01.000Z" }] }), /newer than capturedAt/);
});
