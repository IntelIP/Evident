import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";

import { runGit } from "../scripts/lib/git-process.mjs";
import { tabellioRunnerIdentity, tabellioRunnerState } from "../scripts/lib/runner-identity.mjs";
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
  const dirtyState = await tabellioRunnerState({ root });
  const dirty = dirtyState.identity;
  assert.equal(dirty.sourceDirty, true);
  assert.equal(Object.values(dirty).some((value) => String(value).includes("private-customer-name")), false);
  await writeFile(join(root, "private-customer-name.txt"), "changed while still dirty\n");
  const changedState = await tabellioRunnerState({ root });
  assert.deepEqual(changedState.identity, dirtyState.identity);
  assert.notEqual(changedState.fingerprint, dirtyState.fingerprint);

  const nested = join(root, "nested");
  await mkdir(nested);
  await runGit({ args: ["init", "-b", "main"], cwd: nested });
  await writeFile(join(nested, "nested.txt"), "one\n");
  const nestedState = await tabellioRunnerState({ root });
  assert.equal(nestedState.identity.sourceDirty, true);
  assert.match(nestedState.fingerprint, /^[0-9a-f]{64}$/);
  await runGit({ args: ["add", "nested.txt"], cwd: nested });
  await runGit({ args: ["commit", "-m", "Add nested source"], cwd: nested, env: identityEnv() });
  const committedNestedState = await tabellioRunnerState({ root });
  assert.notEqual(committedNestedState.fingerprint, nestedState.fingerprint);
  await writeFile(join(nested, "nested.txt"), "two\n");
  const changedNestedState = await tabellioRunnerState({ root });
  assert.notEqual(changedNestedState.fingerprint, committedNestedState.fingerprint);
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

test("runner identity does not attribute a parent consumer repository to an installed package", async (t) => {
  const consumer = await temporaryDirectory(t, "TabellioConsumer-");
  await runGit({ args: ["init", "-b", "main"], cwd: consumer });
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0" }));
  await runGit({ args: ["add", "package.json"], cwd: consumer });
  await runGit({ args: ["commit", "-m", "Add consumer"], cwd: consumer, env: identityEnv() });
  const installed = join(consumer, "node_modules", "@intelip", "tabellio");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "package.json"), JSON.stringify({
    name: "@intelip/tabellio",
    version: "0.6.0",
  }));

  assert.deepEqual(await tabellioRunnerIdentity({ root: installed }), {
    packageName: "@intelip/tabellio",
    packageVersion: "0.6.0",
    sourceCommit: null,
    sourceDirty: null,
    releaseTag: null,
  });
});

test("runner identity CLI workflow reports current checkout and enforces expectations", async (t) => {
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

  const outside = await temporaryDirectory(t, "TabellioCaller-");
  const script = fileURLToPath(new URL("../scripts/tabellio-version.mjs", import.meta.url));
  const outsideResult = await execFileAsync(process.execPath, [
    script,
    "--expect-ref", "HEAD",
  ], { cwd: outside, encoding: "utf8" });
  assert.equal(JSON.parse(outsideResult.stdout).ok, true);

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

  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/tabellio-version.mjs",
      "--expect-ref", "--show-toplevel",
    ], { cwd: new URL("..", import.meta.url), encoding: "utf8" }),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.equal(error.stderr.includes(new URL("..", import.meta.url).pathname), false);
      return true;
    },
  );
});

test("runner identity operational lookup stays bounded", async () => {
  const started = performance.now();
  for (let index = 0; index < 10; index += 1) await tabellioRunnerIdentity();
  const duration = performance.now() - started;
  console.log(`runner_identity_10x_duration_ms=${duration.toFixed(3)}`);
});

test("runner identity fingerprints tracked changes larger than the Git output buffer", async (t) => {
  const root = await identityFixture(t);
  const large = join(root, "large.bin");
  await writeFile(large, Buffer.alloc(11 * 1024 * 1024, 1));
  await runGit({ args: ["add", "large.bin"], cwd: root });
  await runGit({ args: ["commit", "-m", "Add large file"], cwd: root, env: identityEnv() });
  await writeFile(large, Buffer.alloc(11 * 1024 * 1024, 2));
  const state = await tabellioRunnerState({ root });
  assert.equal(state.identity.sourceDirty, true);
  assert.match(state.fingerprint, /^[0-9a-f]{64}$/);
});

test("runner identity inspection does not refresh the Git index", async (t) => {
  const root = await identityFixture(t);
  const packagePath = join(root, "package.json");
  const now = new Date();
  await utimes(packagePath, now, now);
  const before = await stat(join(root, ".git", "index"));
  await tabellioRunnerState({ root });
  const after = await stat(join(root, ".git", "index"));
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ctimeMs, before.ctimeMs);
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
