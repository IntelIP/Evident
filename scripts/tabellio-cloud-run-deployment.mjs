#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { collectCloudRunDeploymentReceipt } from "./lib/cloud-run-deployment-collector.mjs";
import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { writeDeploymentCollection } from "./lib/deployment-cli.mjs";

const execFileAsync = promisify(execFile);

main().catch(reportCliError);

async function main() {
  const options = parseCommandOptions(process.argv.slice(2), {
    collect: ["repository", "environment", "service", "project", "region", "out"],
  });
  requireOptions(
    options,
    ["repository", "environment", "service", "project", "region", "out"],
    "collect",
  );
  await writeDeploymentCollection({
    collector: collectCloudRunDeploymentReceipt,
    provider: "cloud_run",
    out: options.out,
    input: {
      repository: options.repository,
      environment: options.environment,
      service: options.service,
      project: options.project,
      region: options.region,
      request: () => cloudRunRequest(options),
    },
  });
}

async function cloudRunRequest(options) {
  const base = [
    "--platform", "managed",
    "--project", options.project,
    "--region", options.region,
    "--format=json",
  ];
  const service = await gcloudJson([
    "run", "services", "describe", options.service, ...base,
  ]);
  const revisionName = service?.status?.traffic?.find((entry) =>
    entry?.percent === 100
  )?.revisionName;
  if (typeof revisionName !== "string") {
    throw new Error("Cloud Run service has no single serving revision.");
  }
  const revision = await gcloudJson([
    "run", "revisions", "describe", revisionName, ...base,
  ]);
  return { service, revision };
}

async function gcloudJson(argv) {
  const result = await execFileAsync("gcloud", argv, {
    maxBuffer: 5 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}
