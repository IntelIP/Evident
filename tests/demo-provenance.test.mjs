import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const postgresAvailable = spawnSync("initdb", ["--version"]).status === 0;

test("sample PostgreSQL demo works under a long isolated temporary path", { skip: !postgresAvailable }, async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-long-tmp-"));
  const nested = join(root, "isolated-validation-home-".repeat(5), "tmp");
  await mkdir(nested, { recursive: true });
  const script = fileURLToPath(new URL("../scripts/demo-provenance.mjs", import.meta.url));
  const result = await execute(process.execPath, [script], {
    env: { ...process.env, TMPDIR: nested }, timeout: 60000, maxBuffer: 1024 * 1024,
  });
  const receipt = JSON.parse(result.stdout);
  // Preserve recovery data if the child could not establish safe cleanup.
  assert.equal(receipt.cleanup, "passed");
  await rm(root, { recursive: true, force: true });
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.checks.postgresServerRestart, "passed");
});
