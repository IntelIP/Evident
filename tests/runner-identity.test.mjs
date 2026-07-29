import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";

import { runGit } from "../scripts/lib/git-process.mjs";
import { tabellioRunnerIdentity } from "../scripts/lib/runner-identity.mjs";
import { identityEnv } from "./helpers/git-fixture.mjs";

const execFileAsync = promisify(execFile);

test("runner identity schema binds package version, source commit, cleanliness, and release tag", async (t) => {
  const root = await identityFixture(t);
  const clean = await tabellioRunnerIdentity({ root });
  assert.equal(clean.packageName, "@intelip/tabellio");
  assert.equal(clean.packageVersion, "0.6.0");
  assert.match(clean.sourceCommit, /^[0-9a-f]{40}$/);
  assert.equal(clean.sourceDirty, false);
  assert.equal(clean.releaseTag, null);

  await runGit({ args: ["tag", "v0.6.0"], cwd: root });
  assert.equal((await tabellioRunnerIdentity({ root })).releaseTag, "v0.6.0");

  await writeFile(join(root, "private-customer-name.txt"), "not exported\n");
  const dirty = await tabellioRunnerIdentity({ root });
  assert.equal(dirty.sourceDirty, true);
  assert.equal(Object.values(dirty).some((value) => String(value).includes("private-customer-name")), false);
});

test("runner identity security reports unavailable non-Git source without exposing paths", async (t) => {
  const root = await temporaryDirectory(t, "TabellioPackage-");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@intelip/tabellio",
    version: "0.6.0",
  }));
  const identity = await tabellioRunnerIdentity({ root });
  assert.deepEqual(identity, {
    packageName: "@intelip/tabellio",
    packageVersion: "0.6.0",
    sourceCommit: null,
    sourceDirty: null,
    releaseTag: null,
  });
  assert.equal(JSON.stringify(identity).includes(root), false);
});

test("runner identity CLI workflow reports current checkout and enforces expectations", async () => {
  const result = await execFileAsync(process.execPath, [
    "scripts/tabellio-version.mjs",
    "--expect-version", "0.6.0",
    "--expect-ref", "HEAD",
  ], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.runner.packageVersion, "0.6.0");
  assert.match(value.runner.sourceCommit, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  assert.deepEqual(Object.keys(value.runner).sort(), [
    "packageName",
    "packageVersion",
    "releaseTag",
    "sourceCommit",
    "sourceDirty",
  ]);

  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/tabellio-version.mjs",
      "--expect-version", "9.9.9",
    ], { cwd: new URL("..", import.meta.url), encoding: "utf8" }),
    (error) => {
      const blocked = JSON.parse(error.stdout);
      assert.equal(error.code, 1);
      assert.equal(blocked.ok, false);
      assert.deepEqual(blocked.blockers, ["package_version_mismatch:9.9.9"]);
      return true;
    },
  );
});

test("runner identity operational lookup stays bounded", async () => {
  const started = performance.now();
  for (let index = 0; index < 10; index += 1) await tabellioRunnerIdentity();
  const duration = performance.now() - started;
  console.log(`runner_identity_10x_duration_ms=${duration.toFixed(3)}`);
  assert(duration < 2_000);
});

async function identityFixture(t) {
  const root = await temporaryDirectory(t, "TabellioIdentity-");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@intelip/tabellio",
    version: "0.6.0",
  }));
  await runGit({ args: ["init", "-b", "main"], cwd: root });
  await runGit({ args: ["add", "package.json"], cwd: root });
  await runGit({
    args: ["commit", "-m", "Add package identity"],
    cwd: root,
    env: identityEnv(),
  });
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "0.6.0");
  return root;
}

async function temporaryDirectory(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
