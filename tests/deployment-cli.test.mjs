import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { writeDeploymentCollection } from "../scripts/lib/deployment-cli.mjs";

test("deployment CLI writes the provider receipt result", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-deployment-cli-"));
  const out = join(root, "receipt.json");
  await writeDeploymentCollection({
    collector: async (input) => ({ status: "available", reason: null, receipt: input }),
    input: { id: "receipt-1" },
    out,
    provider: "cloud_run",
  });
  assert.deepEqual(JSON.parse(await readFile(out, "utf8")), {
    status: "available", reason: null, receipt: { id: "receipt-1" },
  });
});

test("delivery evidence CLI refuses to overwrite an input snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-delivery-evidence-"));
  const provider = join(root, "provider.json");
  const script = fileURLToPath(new URL("../scripts/tabellio-delivery-evidence.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "join", "--provider", provider, "--plane", join(root, "plane.json"), "--buildkite", join(root, "buildkite.json"), "--releases", join(root, "releases.json"), "--out", provider], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must not alias an input snapshot/);
});

test("Vercel deployment CLI accepts the documented project-id option", () => {
  const script = fileURLToPath(new URL("../scripts/tabellio-vercel-deployment.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "collect", "--repository", "IntelIP/Vaticor", "--environment", "production", "--project-id", "prj_abc", "--out", "/tmp/tabellio-vercel-receipt.json"], { encoding: "utf8", env: {} });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VERCEL_API_TOKEN is required/);
  assert.doesNotMatch(result.stderr, /Unsupported option/);
});
