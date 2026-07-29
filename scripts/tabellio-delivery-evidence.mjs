#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  parseCommandOptions,
  reportCliError,
  requireOptions,
} from "./lib/cli-options.mjs";
import { joinDeliveryEvidence } from "./lib/delivery-evidence-joiner.mjs";
import { extractDeploymentReceipts } from "./lib/deployment-receipt-input.mjs";
import { assertOutputDistinctFromInputs } from "./lib/output-boundary.mjs";

main().catch(reportCliError);

async function main() {
  const options = parseOptions();
  validateOptions(options);
  await assertOutputDistinctFromInputs({
    output: options.out,
    inputs: inputPaths(options),
  });
  const inputs = await readInputs(options);
  const snapshot = joinDeliveryEvidence({
    providerSnapshot: inputs.providerSnapshot,
    planeSnapshot: inputs.planeSnapshot,
    buildkiteAuthority: {
      organization: options.buildkiteOrganization,
      pipeline: options.buildkitePipeline,
    },
    buildkiteSnapshots: [inputs.buildkiteSnapshot],
    releaseSnapshot: inputs.releaseSnapshot,
    deploymentReceipts: inputs.deployment.receipts,
    deploymentBlockedReason: inputs.deployment.blockedReason,
    deploymentEnvironment: optionalValue(options.deploymentEnvironment),
  });
  const out = resolve(options.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    status: "delivery_evidence_joined",
    repository: snapshot.repository,
    deliveryRecordCount: snapshot.deliveryRecords.length,
    out,
  }, null, 2));
}

function parseOptions() {
  return parseCommandOptions(process.argv.slice(2), {
    join: [
      "provider",
      "plane",
      "buildkite",
      "buildkiteOrganization",
      "buildkitePipeline",
      "releases",
      "deployments",
      "deploymentEnvironment",
      "out",
    ],
  });
}

function validateOptions(options) {
  requireOptions(options, [
    "provider",
    "plane",
    "buildkite",
    "buildkiteOrganization",
    "buildkitePipeline",
    "releases",
    "out",
  ], "join");
  if (options.deployments && !options.deploymentEnvironment) {
    throw new Error("--deployment-environment is required with --deployments.");
  }
}

function inputPaths(options) {
  return [
    options.provider,
    options.plane,
    options.buildkite,
    options.releases,
    options.deployments,
  ].filter(Boolean);
}

async function readInputs(options) {
  const [
    providerSnapshot,
    planeSnapshot,
    buildkiteSnapshot,
    releaseSnapshot,
  ] = await Promise.all([
    readJson(options.provider),
    readJson(options.plane),
    readJson(options.buildkite),
    readJson(options.releases),
  ]);
  return {
    providerSnapshot,
    planeSnapshot,
    buildkiteSnapshot,
    releaseSnapshot,
    deployment: await readDeployment(options.deployments),
  };
}

async function readDeployment(path) {
  if (!path) return { receipts: [], blockedReason: null };
  return extractDeploymentReceipts(await readJson(path));
}

function optionalValue(value) {
  return value ?? null;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}
