#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { collectVercelDeploymentReceipt } from "./lib/vercel-deployment-collector.mjs";
main().catch(reportCliError);
async function main() {
  const options = parseCommandOptions(process.argv.slice(2), { collect: ["repository", "environment", "project-id", "out"] });
  requireOptions(options, ["repository", "environment", "projectId", "out"], "collect");
  const token = process.env.VERCEL_API_TOKEN;
  if (!token) throw new Error("VERCEL_API_TOKEN is required at runtime.");
  const result = await collectVercelDeploymentReceipt({ repository: options.repository, environment: options.environment, projectId: options.projectId, capturedAt: new Date().toISOString(), request: async () => {
    const response = await fetch(`https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(options.projectId)}&target=production&limit=20`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error("Vercel API request failed.");
    return response.json();
  } });
  await writeFile(resolve(options.out), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ok: result.status === "available", status: result.status === "available" ? "vercel_deployment_receipt_ready" : "vercel_deployment_receipt_blocked", out: resolve(options.out) }, null, 2));
  if (result.status !== "available") process.exitCode = 1;
}
