#!/usr/bin/env node
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { collectCloudRunDeploymentReceipt } from "./lib/cloud-run-deployment-collector.mjs";
import { writeDeploymentCollection } from "./lib/deployment-cli.mjs";
const execFileAsync = promisify(execFile);
main().catch(reportCliError);
async function main() {
  const options = parseCommandOptions(process.argv.slice(2), { collect: ["repository", "environment", "service", "project", "region", "out"] });
  requireOptions(options, ["repository", "environment", "service", "project", "region", "out"], "collect");
  await writeDeploymentCollection({ collector: collectCloudRunDeploymentReceipt, provider: "cloud_run", out: options.out, input: { repository: options.repository, environment: options.environment, service: options.service, project: options.project, region: options.region, capturedAt: new Date().toISOString(), request: async () => {
    const base = ["--platform", "managed", "--project", options.project, "--region", options.region, "--format=json"];
    const serviceResult = await execFileAsync("gcloud", ["run", "services", "describe", options.service, ...base], { maxBuffer: 5 * 1024 * 1024 });
    const service = JSON.parse(serviceResult.stdout);
    const revisionName = service?.status?.traffic?.find((entry) => entry?.percent === 100)?.revisionName;
    if (typeof revisionName !== "string") throw new Error("Cloud Run service has no single serving revision.");
    const revisionResult = await execFileAsync("gcloud", ["run", "revisions", "describe", revisionName, ...base], { maxBuffer: 5 * 1024 * 1024 });
    return { service, revision: JSON.parse(revisionResult.stdout) };
  } } });
}
