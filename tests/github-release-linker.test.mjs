import assert from "node:assert/strict";
import test from "node:test";

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

test("GitHub release linker attaches an exact release timestamp to matching delivery work", () => {
  const linked = linkGitHubReleases({ providerSnapshot, releaseSnapshot });
  assert.equal(linked.deliveryChanges[0].releasedAt, "2026-07-25T10:30:00.000Z");
  assert.equal(linked.sources.github.version, providerSnapshot.sources.github.version);
  assert.equal(linked.capturedAt, providerSnapshot.capturedAt);
  assert.equal(providerSnapshot.deliveryChanges[0].releasedAt, null);
});
test("GitHub release linker never rolls GitHub source version backward",()=>{const linked=linkGitHubReleases({providerSnapshot,releaseSnapshot});assert.equal(linked.sources.github.version,"2026-07-25T12:00:00.000Z");});

test("GitHub release linker rejects conflicting release evidence", () => {
  assert.throws(() => linkGitHubReleases({
    providerSnapshot: { ...providerSnapshot, deliveryChanges: [{ ...providerSnapshot.deliveryChanges[0], releasedAt: "2026-07-25T10:20:00.000Z" }] },
    releaseSnapshot,
  }), /Conflicting GitHub release timestamp/);
});

test("GitHub release linker rejects an unavailable release source", () => {
  assert.throws(() => linkGitHubReleases({
    providerSnapshot,
    releaseSnapshot: { ...releaseSnapshot, status: "blocked", reason: "GitHub release collection unavailable.", releases: [] },
  }), /Cannot link a blocked/);
});
