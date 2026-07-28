#!/usr/bin/env node

import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { writeDeploymentCollection } from "./lib/deployment-cli.mjs";
import { collectVercelDeploymentReceipt } from "./lib/vercel-deployment-collector.mjs";

main().catch(reportCliError);

async function main() {
  const options = parseCommandOptions(process.argv.slice(2), {
    collect: ["repository", "environment", "projectId", "out"],
  });
  requireOptions(options, ["repository", "environment", "projectId", "out"], "collect");
  if (options.environment !== "production") {
    throw new Error("Vercel deployment evidence requires --environment production.");
  }
  const token = process.env.VERCEL_API_TOKEN;
  if (!token) throw new Error("VERCEL_API_TOKEN is required at runtime.");
  await writeDeploymentCollection({
    collector: collectVercelDeploymentReceipt,
    provider: "vercel",
    out: options.out,
    input: {
      repository: options.repository,
      environment: options.environment,
      projectId: options.projectId,
      request: () => vercelRequest(options.projectId, token),
    },
  });
}

async function vercelRequest(projectId, token) {
  const query = new URLSearchParams({
    projectId,
    target: "production",
    limit: "20",
  });
  const response = await fetch(`https://api.vercel.com/v6/deployments?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Vercel API request failed.");
  return response.json();
}
