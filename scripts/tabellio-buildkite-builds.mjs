#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { collectBuildkiteBuildSnapshot } from "./lib/buildkite-build-collector.mjs";

main().catch(reportCliError);

async function main() {
  const options = parseCommandOptions(process.argv.slice(2), { collect: ["repository", "organization", "pipeline", "out"] });
  requireOptions(options, ["repository", "organization", "pipeline", "out"], "collect");
  const token = process.env.BUILDKITE_API_TOKEN;
  if (!token) throw new Error("BUILDKITE_API_TOKEN is required at runtime.");
  const snapshot = await collectBuildkiteBuildSnapshot({
    repository: options.repository,
    organization: options.organization,
    pipeline: options.pipeline,
    capturedAt: new Date().toISOString(),
    request: async (path) => {
      const response = await fetch(new URL(path, "https://api.buildkite.com").href, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Buildkite API request failed.");
      return response.json();
    },
  });
  const out = resolve(options.out);
  await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: snapshot.status === "available",
    status: snapshot.status === "available" ? "buildkite_build_snapshot_ready" : "buildkite_build_snapshot_blocked",
    organization: snapshot.organization,
    pipeline: snapshot.pipeline,
    buildCount: snapshot.builds.length,
    out,
  }, null, 2));
  if (snapshot.status !== "available") process.exitCode = 1;
}
