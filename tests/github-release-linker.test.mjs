import assert from "node:assert/strict";
import test from "node:test";

import { createGitCommitContainmentResolver } from "../scripts/lib/git-commit-containment.mjs";
import { linkGitHubReleases } from "../scripts/lib/github-release-linker.mjs";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const RELEASE = "c".repeat(40);

test("release linker resolves squash delivery through landed merge containment", async () => {
  const calls = [];
  const linked = await linkGitHubReleases({
    providerSnapshot: providerSnapshot({
      mergeCommit: MERGE,
      capturedAt: "2026-07-25T12:00:00.000Z",
    }),
    releaseSnapshot: releaseSnapshot({
      commit: RELEASE,
      capturedAt: "2026-07-25T13:00:00.000Z",
    }),
    containsCommit: async (ancestor, descendant) => {
      calls.push([ancestor, descendant]);
      return ancestor === MERGE && descendant === RELEASE;
    },
  });
  assert.deepEqual(calls, [[MERGE, RELEASE]]);
  assert.equal(linked.deliveryChanges[0].releasedAt, "2026-07-25T11:00:00.000Z");
  assert.equal(linked.deliveryChanges[0].releaseCommit, RELEASE);
  assert.equal(linked.sources.github.version, "2026-07-25T13:00:00.000Z");
  assert.equal(linked.capturedAt, "2026-07-25T13:00:00.000Z");
});

test("release linker preserves newer GitHub source version", async () => {
  const linked = await linkGitHubReleases({
    providerSnapshot: providerSnapshot({
      githubVersion: "2026-07-25T14:00:00.000Z",
      capturedAt: "2026-07-25T14:00:00.000Z",
    }),
    releaseSnapshot: releaseSnapshot(),
  });
  assert.equal(linked.sources.github.version, "2026-07-25T14:00:00.000Z");
  assert.equal(linked.capturedAt, "2026-07-25T14:00:00.000Z");
});

test("release linker excludes pre-merge releases", async () => {
  const linked = await linkGitHubReleases({
    providerSnapshot: providerSnapshot({ mergeCommit: MERGE }),
    releaseSnapshot: releaseSnapshot({ publishedAt: "2026-07-25T09:59:59.000Z" }),
    containsCommit: async () => true,
  });
  assert.equal(linked.deliveryChanges[0].releasedAt, undefined);
  assert.equal(linked.deliveryChanges[0].releaseCommit, undefined);
});

test("release linker requires landed merge identity before linking", async () => {
  const linked = await linkGitHubReleases({
    providerSnapshot: providerSnapshot(),
    releaseSnapshot: releaseSnapshot(),
    containsCommit: async () => true,
  });
  assert.equal(linked.deliveryChanges[0].releasedAt, undefined);
});

test("release linker rejects malformed provider snapshots before linking", async () => {
  const malformed = providerSnapshot();
  malformed.deliveryChanges[0].storyCreatedAt = "2026-07-25T11:00:00.000Z";
  malformed.deliveryChanges[0].mergedAt = "2026-07-25T10:00:00.000Z";
  await assert.rejects(() => linkGitHubReleases({
    providerSnapshot: malformed,
    releaseSnapshot: releaseSnapshot(),
  }), /Invalid provider snapshot.*storyCreatedAt is later/);
});

test("release linker rejects conflicting existing release claims", async () => {
  await assert.rejects(() => linkGitHubReleases({
    providerSnapshot: providerSnapshot({
      mergeCommit: MERGE,
      releasedAt: "2026-07-25T10:30:00.000Z",
      releaseCommit: MERGE,
    }),
    releaseSnapshot: releaseSnapshot({ commit: MERGE }),
  }), /Conflicting GitHub release timestamp/);
});

test("git containment resolver binds repository and fail-closes unexpected errors", async () => {
  const execute = async (_command, args) => {
    if (args.includes("get-url")) {
      return { stdout: "https://github.com/IntelIP/Tabellio.git\n" };
    }
    if (args.includes("missing")) {
      throw Object.assign(new Error("missing"), { code: 128 });
    }
    if (args.includes("not-contained")) {
      throw Object.assign(new Error("not ancestor"), { code: 1 });
    }
    if (args.includes("provider-error")) {
      throw Object.assign(new Error("provider"), { code: 128 });
    }
    return { stdout: "" };
  };
  const contains = await createGitCommitContainmentResolver({
    repo: "/safe/repository",
    expectedRepository: "IntelIP/Tabellio",
    execute,
  });
  assert.equal(await contains(HEAD, RELEASE), true);
  assert.equal(await contains(HEAD, "d".repeat(40)), true);
  assert.equal(await contains(HEAD, "e".repeat(40)), true);
  assert.equal(await contains(HEAD, "not-contained"), false);
  assert.equal(await contains(HEAD, "missing"), false);
  await assert.rejects(() => createGitCommitContainmentResolver({
    repo: "/safe/repository",
    expectedRepository: "IntelIP/Other",
    execute,
  }), /identity mismatch/);
});

function providerSnapshot({
  mergeCommit,
  releasedAt,
  releaseCommit,
  githubVersion = "2026-07-25T12:00:00.000Z",
  capturedAt = "2026-07-25T12:00:00.000Z",
} = {}) {
  const change = {
    id: "change-1",
    linkBasis: "explicit",
    linkEvidence: "INTB-261 to PR binding",
    planeStoryId: "INTB-261",
    pullRequestNumber: 35,
    storyCreatedAt: "2026-07-25T09:00:00.000Z",
    firstActivityAt: "2026-07-25T09:30:00.000Z",
    mergedAt: "2026-07-25T10:00:00.000Z",
    headCommit: HEAD,
    validationStatus: "unavailable",
    hostedStatus: "passed",
  };
  if (mergeCommit !== undefined) change.mergeCommit = mergeCommit;
  if (releasedAt !== undefined) change.releasedAt = releasedAt;
  if (releaseCommit !== undefined) change.releaseCommit = releaseCommit;
  return {
    schemaVersion: "tabellio-analytics-provider-snapshot/v0.1",
    repository: "IntelIP/Tabellio",
    headCommit: HEAD,
    capturedAt,
    sources: {
      plane: { status: "available", version: "2026-07-25T09:00:00.000Z" },
      github: { status: "available", version: githubVersion },
      "github-actions": { status: "available", version: "2026-07-25T11:00:00.000Z" },
      buildkite: { status: "available", version: "2026-07-25T11:00:00.000Z" },
    },
    deliveryChanges: [change],
  };
}

function releaseSnapshot({
  commit = HEAD,
  publishedAt = "2026-07-25T11:00:00.000Z",
  capturedAt = "2026-07-25T12:00:00.000Z",
} = {}) {
  return {
    schemaVersion: "tabellio-github-release-snapshot/v0.1",
    repository: "IntelIP/Tabellio",
    capturedAt,
    status: "available",
    reason: null,
    releases: [{
      id: "1",
      tagName: "v1.0.0",
      publishedAt,
      commit,
      commitStatus: "resolved",
    }],
  };
}
