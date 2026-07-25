import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
