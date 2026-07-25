#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { joinDeliveryEvidence } from "./lib/delivery-evidence-joiner.mjs";
import { assertOutputBoundary } from "./lib/output-boundary.mjs";

main().catch(reportCliError);
async function main() {
  const options = parseCommandOptions(process.argv.slice(2), { join: ["provider", "plane", "buildkite", "releases", "deployments", "out"] });
  requireOptions(options, ["provider", "plane", "buildkite", "releases", "out"], "join");
  await assertOutputBoundary({
    outputs: [options.out], protectedInputs: [options.provider, options.plane, options.buildkite, options.releases, options.deployments].filter(Boolean),
    duplicatePathMessage: "--out must identify one output path.", symbolicLinkMessage: "--out must not be a symbolic link.",
    outputAliasMessage: "--out must identify one output file.", inputAliasMessage: "--out must not alias an input snapshot.",
    protectedRootMessage: "--out must not be inside a protected input root.",
  });
  const [providerSnapshot, planeSnapshot, buildkiteSnapshot, releaseSnapshot, deploymentInput] = await Promise.all([options.provider, options.plane, options.buildkite, options.releases, options.deployments].filter(Boolean).map(readJson));
  const deploymentReceipts = deploymentInput ? extractDeploymentReceipts(deploymentInput) : [];
  const snapshot = joinDeliveryEvidence({ providerSnapshot, planeSnapshot, buildkiteSnapshots: [buildkiteSnapshot], releaseSnapshot, deploymentReceipts });
  const out = resolve(options.out); await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, repository: snapshot.repository, deliveryRecordCount: snapshot.deliveryRecords.length, out }, null, 2));
}
async function readJson(path) { return JSON.parse(await readFile(resolve(path), "utf8")); }
function extractDeploymentReceipts(input) {
  if (Array.isArray(input)) return input;
  if (input?.status === "available" && input.receipt) return [input.receipt];
  if (input?.schemaVersion === "tabellio-deployment-receipt/v0.1") return [input];
  throw new Error("--deployments must contain deployment receipts or a collector result.");
}
