import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("GitHub release CLI returns nonzero when provider access is blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-github-release-cli-"));
  const out = join(root, "snapshot.json");
  const result = await execFileAsync(process.execPath, [
    "scripts/tabellio-github-releases.mjs",
    "collect",
    "--repository", "IntelIP/Tabellio",
    "--out", out,
  ], { cwd: process.cwd(), env: { ...process.env, PATH: root } }).then(
    () => assert.fail("Expected blocked collection to exit nonzero."),
    (error) => error,
  );
  assert.equal(result.code, 1);
  const snapshot = JSON.parse(await readFile(out, "utf8"));
  assert.equal(snapshot.status, "blocked");
});
