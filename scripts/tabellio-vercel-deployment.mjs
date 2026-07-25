#!/usr/bin/env node
import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { collectVercelDeploymentReceipt } from "./lib/vercel-deployment-collector.mjs";
import { writeDeploymentCollection } from "./lib/deployment-cli.mjs";
main().catch(reportCliError);
async function main() {
  const options = parseCommandOptions(process.argv.slice(2), { collect: ["repository", "environment", "project-id", "out"] });
  requireOptions(options, ["repository", "environment", "projectId", "out"], "collect");
  const token = process.env.VERCEL_API_TOKEN;
  if (!token) throw new Error("VERCEL_API_TOKEN is required at runtime.");
  await writeDeploymentCollection({ collector: collectVercelDeploymentReceipt, provider: "vercel", out: options.out, input: { repository: options.repository, environment: options.environment, projectId: options.projectId, capturedAt: new Date().toISOString(), request: async () => {
    const response = await fetch(`https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(options.projectId)}&target=production&limit=20`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error("Vercel API request failed.");
    return response.json();
  } } });
}
