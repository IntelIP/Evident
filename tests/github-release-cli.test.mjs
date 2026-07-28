import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("GitHub release collector CLI writes bounded blocked evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-release-collect-"));
  const out = join(root, "nested", "snapshot.json");
  const result = await execFileAsync(process.execPath, [
    "scripts/tabellio-github-releases.mjs",
    "collect",
    "--repository", "IntelIP/Tabellio",
    "--out", out,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: root },
  }).then(
    () => assert.fail("Expected blocked collection."),
    (error) => error,
  );
  assert.equal(result.code, 1);
  const snapshot = JSON.parse(await readFile(out, "utf8"));
  assert.equal(snapshot.status, "blocked");
});

test("release-link CLI rejects direct, hard-link, and symlink input aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-release-link-"));
  const provider = join(root, "provider.json");
  const releases = join(root, "releases.json");
  await writeFile(provider, "{}\n");
  await writeFile(releases, "{}\n");
  const hardLink = join(root, "provider-hard-link.json");
  const symbolicLink = join(root, "provider-symbolic-link.json");
  await link(provider, hardLink);
  await symlink(provider, symbolicLink);

  for (const out of [provider, hardLink, symbolicLink]) {
    const result = await runLink({ provider, releases, out });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /must not (?:alias an input snapshot|be a symbolic link)/);
  }
});

test("release-link CLI rejects symlinked inputs before reading them", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-release-link-input-"));
  const provider = join(root, "provider.json");
  const providerLink = join(root, "provider-link.json");
  const releases = join(root, "releases.json");
  await writeFile(provider, "{}\n");
  await writeFile(releases, "{}\n");
  await symlink(provider, providerLink);
  const result = await runLink({
    provider: providerLink,
    releases,
    out: join(root, "output.json"),
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /inputs must not be symbolic links/);
});

async function runLink({ provider, releases, out }) {
  await mkdir(dirname(out), { recursive: true });
  return execFileAsync(process.execPath, [
    "scripts/tabellio-analytics-releases.mjs",
    "link",
    "--provider-snapshot", provider,
    "--github-release-snapshot", releases,
    "--out", out,
  ], { cwd: process.cwd() }).then(
    () => assert.fail("Expected link command to fail."),
    (error) => error,
  );
}
