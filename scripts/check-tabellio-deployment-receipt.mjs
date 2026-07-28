#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { reportCliError } from "./lib/cli-options.mjs";
import { validateDeploymentReceipt } from "./lib/deployment-receipt.mjs";

main().catch(reportCliError);

async function main() {
  const index = process.argv.indexOf("--receipt");
  const path = index >= 0 ? process.argv[index + 1] : null;
  if (!path || process.argv.length !== 4) {
    throw new Error("Usage: check-tabellio-deployment-receipt --receipt <path>.");
  }
  const receipt = validateDeploymentReceipt(
    JSON.parse(await readFile(resolve(path), "utf8")),
  );
  console.log(JSON.stringify({
    ok: true,
    status: "deployment_receipt_ready",
    path,
    summary: {
      repository: receipt.repository,
      environment: receipt.environment,
      commit: receipt.commit,
      deploymentStatus: receipt.status,
      deployedAt: receipt.deployedAt,
      releaseTag: receipt.releaseTag,
    },
  }, null, 2));
}
