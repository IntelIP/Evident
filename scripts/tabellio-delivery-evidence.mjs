#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { joinDeliveryEvidence } from "./lib/delivery-evidence-joiner.mjs";

main().catch(reportCliError);
async function main() {
  const options = parseCommandOptions(process.argv.slice(2), { join: ["provider", "plane", "buildkite", "releases", "out"] });
  requireOptions(options, ["provider", "plane", "buildkite", "releases", "out"], "join");
  const [providerSnapshot, planeSnapshot, buildkiteSnapshot, releaseSnapshot] = await Promise.all([options.provider, options.plane, options.buildkite, options.releases].map(readJson));
  const snapshot = joinDeliveryEvidence({ providerSnapshot, planeSnapshot, buildkiteSnapshots: [buildkiteSnapshot], releaseSnapshot });
  const out = resolve(options.out); await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, repository: snapshot.repository, deliveryRecordCount: snapshot.deliveryRecords.length, out }, null, 2));
}
async function readJson(path) { return JSON.parse(await readFile(resolve(path), "utf8")); }
