import assert from "node:assert/strict";
import test from "node:test";

import { collectGitHubReleaseSnapshot, validateGitHubReleaseSnapshot } from "../scripts/lib/github-release-collector.mjs";

const CAPTURED_AT = "2026-07-25T12:00:00.000Z";
const COMMIT = "a".repeat(40);

test("GitHub release collector resolves a published tag to an exact commit", async () => {
  const calls = [];
  const snapshot = await collectGitHubReleaseSnapshot({
    repository: "IntelIP/Tabellio",
    capturedAt: CAPTURED_AT,
    request: async (path) => {
      calls.push(path);
      if (path.endsWith("/releases?per_page=100")) return [{ id: 12, tag_name: "v0.6.0", published_at: "2026-07-25T11:00:00.000Z", draft: false }];
      return { object: { type: "commit", sha: COMMIT } };
    },
  });
  assert.equal(snapshot.status, "available");
  assert.deepEqual(snapshot.releases, [{ id: "12", tagName: "v0.6.0", publishedAt: "2026-07-25T11:00:00.000Z", commit: COMMIT, commitStatus: "resolved" }]);
  assert.equal(calls.length, 2);
});

test("GitHub release collector preserves a release when tag resolution fails", async () => {
  const snapshot = await collectGitHubReleaseSnapshot({
    repository: "IntelIP/Tabellio",
    capturedAt: CAPTURED_AT,
    request: async (path) => {
      if (path.endsWith("/releases?per_page=100")) return [{ id: 12, tag_name: "v0.6.0", published_at: "2026-07-25T11:00:00.000Z", draft: false }];
      throw new Error("tag unavailable");
    },
  });
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.releases[0].commit, null);
  assert.equal(snapshot.releases[0].commitStatus, "blocked");
});

test("GitHub release collector reports provider failure without leaking details", async () => {
  const snapshot = await collectGitHubReleaseSnapshot({
    repository: "IntelIP/Tabellio",
    capturedAt: CAPTURED_AT,
    request: async () => { throw new Error("Bearer private-token"); },
  });
  assert.deepEqual(snapshot, {
    schemaVersion: "tabellio-github-release-snapshot/v0.1",
    repository: "IntelIP/Tabellio",
    capturedAt: CAPTURED_AT,
    status: "blocked",
    reason: "GitHub release collection unavailable.",
    releases: [],
  });
});

test("GitHub release snapshot rejects contradictory exact-commit claims", () => {
  assert.throws(() => validateGitHubReleaseSnapshot({
    schemaVersion: "tabellio-github-release-snapshot/v0.1",
    repository: "IntelIP/Tabellio",
    capturedAt: CAPTURED_AT,
    status: "available",
    reason: null,
    releases: [{ id: "12", tagName: "v0.6.0", publishedAt: "2026-07-25T11:00:00.000Z", commit: null, commitStatus: "resolved" }],
  }), /Resolved release/);
});

test("GitHub release snapshot rejects releases published after capture", () => {
  assert.throws(() => validateGitHubReleaseSnapshot({
    schemaVersion: "tabellio-github-release-snapshot/v0.1", repository: "IntelIP/Tabellio", capturedAt: CAPTURED_AT,
    status: "available", reason: null,
    releases: [{ id: "12", tagName: "v0.6.0", publishedAt: "2026-07-25T12:00:01.000Z", commit: COMMIT, commitStatus: "resolved" }],
  }), /publishedAt cannot be newer than capturedAt/);
});
test("GitHub release collector blocks malformed published timestamps", async () => {
  const snapshot = await collectGitHubReleaseSnapshot({ repository: "IntelIP/Tabellio", capturedAt: CAPTURED_AT, request: async () => [{ id: 12, tag_name: "v0.6.0", published_at: "not-a-date", draft: false }] });
  assert.equal(snapshot.status, "blocked");
});
test("GitHub release snapshot rejects duplicate IDs and tags", () => {
  const release = { id: "12", tagName: "v0.6.0", publishedAt: "2026-07-25T11:00:00.000Z", commit: COMMIT, commitStatus: "resolved" };
  const base = { schemaVersion: "tabellio-github-release-snapshot/v0.1", repository: "IntelIP/Tabellio", capturedAt: CAPTURED_AT, status: "available", reason: null };
  assert.throws(() => validateGitHubReleaseSnapshot({ ...base, releases: [release, { ...release, tagName: "v0.6.1" }] }), /IDs and tag names must be unique/);
  assert.throws(() => validateGitHubReleaseSnapshot({ ...base, releases: [release, { ...release, id: "13" }] }), /IDs and tag names must be unique/);
});
