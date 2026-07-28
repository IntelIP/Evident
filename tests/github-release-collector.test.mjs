import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectGitHubReleaseSnapshot,
  validateGitHubReleaseSnapshot,
} from "../scripts/lib/github-release-collector.mjs";

const CAPTURED_AT = "2026-07-25T12:00:00.000Z";
const COMMIT = "a".repeat(40);

test("GitHub release collector paginates and resolves portable tags", async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    release(index + 1, `releases/v1.0.${index}+build`)
  );
  const snapshot = await collectGitHubReleaseSnapshot({
    repository: "IntelIP/Tabellio",
    capturedAt: CAPTURED_AT,
    request: async (path) => {
      calls.push(path);
      if (path.includes("/releases?")) {
        return path.endsWith("page=1") ? firstPage : [release(101, "v2.0.0+meta.1")];
      }
      return { object: { type: "commit", sha: COMMIT } };
    },
  });
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.releases.length, 101);
  assert.equal(snapshot.releases.at(-1).tagName, "v2.0.0+meta.1");
  assert(calls.includes("/repos/IntelIP/Tabellio/releases?per_page=100&page=2"));
});

test("GitHub release collector preserves older releases during concurrent publication", async () => {
  const snapshot = await collectGitHubReleaseSnapshot({
    repository: "IntelIP/Tabellio",
    capturedAt: CAPTURED_AT,
    request: async (path) => path.includes("/releases?")
      ? [
          release(1, "v1.0.0", "2026-07-25T11:00:00.000Z"),
          release(2, "v1.1.0", "2026-07-25T12:00:01.000Z"),
        ]
      : { object: { type: "commit", sha: COMMIT } },
  });
  assert.equal(snapshot.status, "available");
  assert.deepEqual(snapshot.releases.map((item) => item.id), ["1"]);
});

test("GitHub release collector preserves unresolved tag evidence as blocked", async () => {
  const snapshot = await collectGitHubReleaseSnapshot({
    repository: "IntelIP/Tabellio",
    capturedAt: CAPTURED_AT,
    request: async (path) => {
      if (path.includes("/releases?")) return [release(1, "v1.0.0")];
      throw new Error("private provider response");
    },
  });
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.releases[0].commit, null);
  assert.equal(snapshot.releases[0].commitStatus, "blocked");
});

test("GitHub release collector blocks malformed published releases", async () => {
  const snapshot = await collectGitHubReleaseSnapshot({
    repository: "IntelIP/Tabellio",
    capturedAt: CAPTURED_AT,
    request: async () => [release(1, "v1.0.0", "not-a-date")],
  });
  assert.equal(snapshot.status, "blocked");
  assert.equal(snapshot.reason, "GitHub release collection unavailable.");
  assert.deepEqual(snapshot.releases, []);
});

test("GitHub release collector bounds repeated full pages", async () => {
  const page = Array.from({ length: 100 }, (_, index) =>
    release(index + 1, `v1.0.${index}`)
  );
  let calls = 0;
  const snapshot = await collectGitHubReleaseSnapshot({
    repository: "IntelIP/Tabellio",
    capturedAt: CAPTURED_AT,
    request: async () => {
      calls += 1;
      return page;
    },
  });
  assert.equal(snapshot.status, "blocked");
  assert.equal(calls, 2);
  console.log("github_release_page_limit=100");
});

test("GitHub release snapshot rejects temporal and duplicate claims", () => {
  const base = availableSnapshot();
  assert.throws(() => validateGitHubReleaseSnapshot({
    ...base,
    releases: [{
      ...base.releases[0],
      publishedAt: "2026-07-25T12:00:01.000Z",
    }],
  }), /newer than capturedAt/);
  assert.throws(() => validateGitHubReleaseSnapshot({
    ...base,
    releases: [
      base.releases[0],
      { ...base.releases[0], tagName: "v2.0.0" },
    ],
  }), /must be unique/);
  assert.throws(() => validateGitHubReleaseSnapshot({
    ...base,
    releases: [
      base.releases[0],
      { ...base.releases[0], id: "2" },
    ],
  }), /must be unique/);
});

test("release schema tag grammar matches collector portable tags", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schemas/github-release-snapshot.v0.1.schema.json", import.meta.url),
    "utf8",
  ));
  const schemaTag = new RegExp(
    schema.properties.releases.items.properties.tagName.pattern,
  );
  for (const tag of ["v1.0.0+build.1", "releases/v1.2.3", "team_a/release-1"]) {
    assert(schemaTag.test(tag), `schema should accept ${tag}`);
    assert.doesNotThrow(() => validateGitHubReleaseSnapshot({
      ...availableSnapshot(),
      releases: [{ ...availableSnapshot().releases[0], tagName: tag }],
    }));
  }
  for (const tag of ["../secret", "release//v1", "release/.hidden", "release/v1.lock"]) {
    assert.equal(schemaTag.test(tag), false, `schema should reject ${tag}`);
    assert.throws(() => validateGitHubReleaseSnapshot({
      ...availableSnapshot(),
      releases: [{ ...availableSnapshot().releases[0], tagName: tag }],
    }), /tag is invalid/);
  }
});

function release(id, tagName, publishedAt = "2026-07-25T11:00:00.000Z") {
  return { id, tag_name: tagName, published_at: publishedAt, draft: false };
}

function availableSnapshot() {
  return {
    schemaVersion: "tabellio-github-release-snapshot/v0.1",
    repository: "IntelIP/Tabellio",
    capturedAt: CAPTURED_AT,
    status: "available",
    reason: null,
    releases: [{
      id: "1",
      tagName: "v1.0.0",
      publishedAt: "2026-07-25T11:00:00.000Z",
      commit: COMMIT,
      commitStatus: "resolved",
    }],
  };
}
