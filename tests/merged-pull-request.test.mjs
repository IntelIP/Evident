import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mergedPullRequestForCommit } from "../scripts/lib/merged-pull-request.mjs";

const mergeCommit = "a".repeat(40);
const headCommit = "b".repeat(40);

test("merged pull-request resolution binds a squash commit to its durable pull ref", () => {
  const result = mergedPullRequestForCommit([
    pullRequest({ mergeCommit: "c".repeat(40), headCommit: "d".repeat(40), number: 23 }),
    pullRequest({ mergeCommit, headCommit, number: 24 }),
  ], mergeCommit);

  assert.deepEqual(result, {
    number: 24,
    headCommit,
    fetchRef: "refs/pull/24/head",
    localRef: "refs/remotes/origin/pull/24/head",
  });
});

test("merged pull-request resolution preserves direct-push checkpoint behavior", () => {
  assert.equal(mergedPullRequestForCommit([], mergeCommit), null);
  assert.equal(mergedPullRequestForCommit([
    { ...pullRequest({ mergeCommit, headCommit, number: 24 }), merged_at: null },
  ], mergeCommit), null);
});

test("merged pull-request resolution fails closed on ambiguous or malformed evidence", () => {
  assert.throws(
    () => mergedPullRequestForCommit([
      pullRequest({ mergeCommit, headCommit, number: 24 }),
      pullRequest({ mergeCommit, headCommit: "c".repeat(40), number: 25 }),
    ], mergeCommit),
    /multiple merged pull requests/,
  );
  assert.throws(
    () => mergedPullRequestForCommit([pullRequest({ mergeCommit, headCommit: "short", number: 24 })], mergeCommit),
    /full hexadecimal Git object ID/,
  );
});

test("Buildkite product validation preserves merged execution and exact checkpoint proof", async () => {
  const script = await readFile(new URL("../.buildkite/scripts/product-validation.sh", import.meta.url), "utf8");
  assert.match(script, /BUILDKITE_PULL_REQUEST:-false/);
  assert.match(script, /commits\/\$\{candidate\}\/pulls/);
  assert.match(script, /resolve-merged-checkpoint\.mjs --commit "\$candidate"/);
  assert.match(script, /Merged checkpoint resolution failed/);
  assert.match(script, /refs\/pull\/\$\{pull_request\}\/head/);
  assert.match(script, /fetched_checkpoint_head=.*git rev-parse/);
  assert.match(script, /\$fetched_checkpoint_head" != "\$resolved_checkpoint_head/);
  assert.match(script, /--checkpoint-base "\$base_ref" --checkpoint-head "\$resolved_checkpoint_head"/);
});

function pullRequest({ mergeCommit: mergedCommit, headCommit: head, number }) {
  return {
    number,
    merged_at: "2026-07-21T10:03:06Z",
    merge_commit_sha: mergedCommit,
    head: { sha: head },
  };
}
