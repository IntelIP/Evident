#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  parseCommandOptions,
  reportCliError,
  requireOptions,
} from "./lib/cli-options.mjs";
import { collectBuildkiteBuildSnapshot } from "./lib/buildkite-build-collector.mjs";

main().catch(reportCliError);

async function main() {
  const options = parseCommandOptions(process.argv.slice(2), {
    collect: ["repository", "organization", "pipeline", "out"],
  });
  requireOptions(
    options,
    ["repository", "organization", "pipeline", "out"],
    "collect",
  );
  const token = process.env.BUILDKITE_API_TOKEN;
  if (!token) throw new Error("BUILDKITE_API_TOKEN is required at runtime.");
  const snapshot = await collectBuildkiteBuildSnapshot({
    repository: options.repository,
    organization: options.organization,
    pipeline: options.pipeline,
    request: (path) => buildkiteRequest(path, token),
  });
  const out = resolve(options.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({
    ok: snapshot.status === "available",
    status: snapshot.status === "available"
      ? "buildkite_build_snapshot_ready"
      : "buildkite_build_snapshot_blocked",
    repository: snapshot.repository,
    organization: snapshot.organization,
    pipeline: snapshot.pipeline,
    capturedAt: snapshot.capturedAt,
    buildCount: snapshot.builds.length,
  }, null, 2));
  if (snapshot.status !== "available") process.exitCode = 1;
}

async function buildkiteRequest(path, token) {
  const url = new URL(path, "https://api.buildkite.com");
  if (url.origin !== "https://api.buildkite.com") {
    throw new Error("Buildkite pagination target is unsafe.");
  }
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) throw new Error("Buildkite API request failed.");
  return {
    body: await response.json(),
    nextPage: response.headers.get("link")?.includes('rel="next"') ?? false,
  };
}
