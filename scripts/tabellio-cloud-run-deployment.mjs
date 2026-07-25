#!/usr/bin/env node
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { collectCloudRunDeploymentReceipt } from "./lib/cloud-run-deployment-collector.mjs";
const execFileAsync = promisify(execFile);
main().catch(reportCliError);
async function main() {
  const options = parseCommandOptions(process.argv.slice(2), { collect: ["repository", "environment", "service", "project", "region", "out"] });
  requireOptions(options, ["repository", "environment", "service", "project", "region", "out"], "collect");
  const result = await collectCloudRunDeploymentReceipt({ repository: options.repository, environment: options.environment, service: options.service, capturedAt: new Date().toISOString(), request: async () => {
    const base = ["--platform", "managed", "--project", options.project, "--region", options.region, "--format=json"];
    const serviceResult = await execFileAsync("gcloud", ["run", "services", "describe", options.service, ...base], { maxBuffer: 5 * 1024 * 1024 });
    const service = JSON.parse(serviceResult.stdout);
    const revisionName = service?.status?.traffic?.find((entry) => entry?.percent === 100)?.revisionName;
    if (typeof revisionName !== "string") throw new Error("Cloud Run service has no single serving revision.");
    const revisionResult = await execFileAsync("gcloud", ["run", "revisions", "describe", revisionName, ...base], { maxBuffer: 5 * 1024 * 1024 });
    return { service, revision: JSON.parse(revisionResult.stdout) };
  } });
  await writeFile(resolve(options.out), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ok: result.status === "available", status: result.status === "available" ? "cloud_run_deployment_receipt_ready" : "cloud_run_deployment_receipt_blocked", out: resolve(options.out) }, null, 2));
  if (result.status !== "available") process.exitCode = 1;
}
