import assert from "node:assert/strict";
import test from "node:test";
import { collectBuildkiteBuildSnapshot } from "../scripts/lib/buildkite-build-collector.mjs";
const at = "2026-07-25T12:00:00.000Z"; const commit = "a".repeat(40);
test("Buildkite collector preserves exact build evidence", async () => {
  const snapshot = await collectBuildkiteBuildSnapshot({ organization: "intelip", pipeline: "tabellio", capturedAt: at, request: async (path) => path.includes("/builds?") ? [{ number: 4, commit, state: "passed", created_at: "2026-07-25T11:00:00.000Z", finished_at: "2026-07-25T11:02:00.000Z" }] : path.includes("/jobs?") ? { items: [{ id: "job-1" }], links: { next: null } } : [{ id: "artifact-1" }, { id: "artifact-2" }] });
  assert.equal(snapshot.status, "available"); assert.deepEqual(snapshot.builds[0], { number: 4, commit, state: "passed", createdAt: "2026-07-25T11:00:00.000Z", finishedAt: "2026-07-25T11:02:00.000Z", jobCount: 1, artifactCount: 2 });
});
test("Buildkite collector blocks safely without error leakage", async () => {
  const snapshot = await collectBuildkiteBuildSnapshot({ organization: "intelip", pipeline: "tabellio", capturedAt: at, request: async () => { throw new Error("token=x"); } });
  assert.equal(snapshot.status, "blocked"); assert.equal(snapshot.reason, "Buildkite build collection unavailable.");
});
