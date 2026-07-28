import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeDeploymentCollection } from "../scripts/lib/deployment-cli.mjs";

test("deployment CLI writes a provider result to a fresh directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-deployment-cli-"));
  const out = join(await realpath(root), "nested", "receipt.json");
  await writeDeploymentCollection({
    collector: async () => ({ status: "available", reason: null, receipt: { id: "receipt-1" } }),
    input: {},
    out,
    provider: "cloud_run",
  });
  assert.equal(JSON.parse(await readFile(out, "utf8")).receipt.id, "receipt-1");
});

test("deployment CLI rejects symlinked output ancestors", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-deployment-alias-"));
  const destination = join(root, "destination");
  await mkdir(destination);
  const throughLink = join(root, "through-link");
  await symlink(destination, throughLink);
  const attempt = () => writeDeploymentCollection({
    collector: async () => ({ status: "available", reason: null, receipt: {} }),
    input: {},
    out: join(throughLink, "receipt.json"),
    provider: "cloud_run",
  });
  await assert.rejects(attempt, /symbolic-link path/);
});

test("Vercel CLI accepts project-id and rejects non-production before provider access", () => {
  const base = [
    "scripts/tabellio-vercel-deployment.mjs",
    "collect",
    "--repository", "IntelIP/Vaticor",
    "--project-id", "prj_abc",
    "--out", "/tmp/tabellio-vercel-receipt.json",
  ];
  const production = spawnSync(process.execPath, [
    ...base,
    "--environment", "production",
  ], { encoding: "utf8", env: {} });
  assert.equal(production.status, 1);
  assert.match(production.stderr, /VERCEL_API_TOKEN is required/);
  assert.doesNotMatch(production.stderr, /Unsupported option/);
  const staging = spawnSync(process.execPath, [
    ...base,
    "--environment", "staging",
  ], { encoding: "utf8", env: {} });
  assert.equal(staging.status, 1);
  assert.match(staging.stderr, /requires --environment production/);
});
