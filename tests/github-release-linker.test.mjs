import assert from "node:assert/strict";
import test from "node:test";

import { createGitCommitContainmentResolver } from "../scripts/lib/git-commit-containment.mjs";
import { linkGitHubReleases } from "../scripts/lib/github-release-linker.mjs";
import { provider as deliveryProvider } from "./helpers/delivery-evidence-fixture.mjs";

const COMMIT = "a".repeat(40);
const providerSnapshot = (() => { const snapshot=deliveryProvider(); snapshot.deliveryChanges[0]={...snapshot.deliveryChanges[0],headCommit:COMMIT,storyCreatedAt:"2026-07-25T09:00:00.000Z",firstActivityAt:"2026-07-25T09:30:00.000Z",mergedAt:"2026-07-25T10:00:00.000Z",releasedAt:null}; return snapshot; })();
const releaseSnapshot = {
  schemaVersion: "tabellio-github-release-snapshot/v0.1",
  repository: "IntelIP/Tabellio",
  capturedAt: "2026-07-25T11:00:00.000Z",
  status: "available",
  reason: null,
  releases: [{ id: "1", tagName: "v0.6.0", publishedAt: "2026-07-25T10:30:00.000Z", commit: COMMIT, commitStatus: "resolved" }],
};

test("GitHub release linker attaches an exact release timestamp to matching delivery work", async () => {
  const linked = await linkGitHubReleases({ providerSnapshot, releaseSnapshot });
  assert.equal(linked.deliveryChanges[0].releasedAt, "2026-07-25T10:30:00.000Z");
  assert.equal(linked.sources.github.version, providerSnapshot.sources.github.version);
  assert.equal(linked.capturedAt, providerSnapshot.capturedAt);
  assert.equal(providerSnapshot.deliveryChanges[0].releasedAt, null);
});
test("GitHub release linker never rolls GitHub source version backward",async()=>{const linked=await linkGitHubReleases({providerSnapshot,releaseSnapshot});assert.equal(linked.sources.github.version,"2026-07-25T12:00:00.000Z");});

test("GitHub release linker rejects conflicting release evidence", async () => {
  await assert.rejects(() => linkGitHubReleases({
    providerSnapshot: { ...providerSnapshot, deliveryChanges: [{ ...providerSnapshot.deliveryChanges[0], releasedAt: "2026-07-25T10:20:00.000Z" }] },
    releaseSnapshot,
  }), /Conflicting GitHub release timestamp/);
});

test("GitHub release linker rejects an unavailable release source", async () => {
  await assert.rejects(() => linkGitHubReleases({
    providerSnapshot,
    releaseSnapshot: { ...releaseSnapshot, status: "blocked", reason: "GitHub release collection unavailable.", releases: [] },
  }), /Cannot link a blocked/);
});

test("GitHub release linker accepts the earliest release commit containing the change", async () => {
  const releaseCommit = "b".repeat(40);
  const linked = await linkGitHubReleases({
    providerSnapshot,
    releaseSnapshot: { ...releaseSnapshot, releases: [{ ...releaseSnapshot.releases[0], commit: releaseCommit }] },
    containsCommit: async (ancestor, descendant) => ancestor === COMMIT && descendant === releaseCommit,
  });
  assert.equal(linked.deliveryChanges[0].releasedAt, releaseSnapshot.releases[0].publishedAt);
  assert.equal(linked.deliveryChanges[0].releaseCommit, releaseCommit);
});
test("GitHub release linker resolves squash releases through the landed merge commit", async () => {
  const mergeCommit = "c".repeat(40);
  const linked = await linkGitHubReleases({
    providerSnapshot: {
      ...providerSnapshot,
      deliveryChanges: [{ ...providerSnapshot.deliveryChanges[0], mergeCommit }],
    },
    releaseSnapshot: {
      ...releaseSnapshot,
      releases: [{ ...releaseSnapshot.releases[0], commit: mergeCommit }],
    },
    containsCommit: async (ancestor, descendant) => ancestor === mergeCommit && descendant === mergeCommit,
  });
  assert.equal(linked.deliveryChanges[0].releasedAt, releaseSnapshot.releases[0].publishedAt);
});

test("Git containment resolver binds repository identity and fail-closes provider errors", async () => {
  const calls = [];
  const failures = new Map([
    ["cat-file:missing-commit^{commit}", Object.assign(new Error("unknown revision"), { code: 128 })],
    ["merge-base:not-contained", Object.assign(new Error("not ancestor"), { code: 1 })],
    ["merge-base:provider-error", Object.assign(new Error("provider failure"), { code: 128 })],
  ]);
  const execute = async (_command, args) => {
    calls.push(args);
    const failure = failures.get(`${args[2]}:${args.at(-1)}`);
    if (failure) throw failure;
    return { stdout: "https://github.com/IntelIP/Tabellio.git\n" };
  };
  const containsCommit = await createGitCommitContainmentResolver({ repo: "/safe/repo", expectedRepository: "IntelIP/Tabellio", execute });
  assert.equal(await containsCommit(COMMIT, COMMIT), true);
  assert.equal(await containsCommit(COMMIT, "contained"), true);
  assert.equal(await containsCommit(COMMIT, "not-contained"), false);
  assert.equal(await containsCommit(COMMIT, "missing-commit"), false);
  await assert.rejects(() => containsCommit(COMMIT, "provider-error"), /could not be verified/);
  assert(calls.some((args) => args.includes("cat-file")));
  assert(calls.some((args) => args.includes("--is-ancestor")));
  await assert.rejects(() => createGitCommitContainmentResolver({ repo: "/safe/repo", expectedRepository: "IntelIP/Other", execute }), /identity mismatch/);
});
