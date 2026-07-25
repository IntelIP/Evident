#!/usr/bin/env node

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { collectGitHubReleaseSnapshot } from "./lib/github-release-collector.mjs";

const execFileAsync = promisify(execFile);

main().catch(reportCliError);

async function main() {
  const options = parseCommandOptions(process.argv.slice(2), { collect: ["repository", "out"] });
  requireOptions(options, ["repository", "out"], "collect");
  const snapshot = await collectGitHubReleaseSnapshot({
    repository: options.repository,
    capturedAt: new Date().toISOString(),
    request: githubRequest,
  });
  const output = `${JSON.stringify(snapshot, null, 2)}\n`;
  const out = resolve(options.out);
  await writeFile(out, output);
  console.log(JSON.stringify({
    ok: snapshot.status === "available",
    status: snapshot.status === "available" ? "github_release_snapshot_ready" : "github_release_snapshot_blocked",
    repository: snapshot.repository,
    releaseCount: snapshot.releases.length,
    out,
  }, null, 2));
}

async function githubRequest(path) {
  const { stdout } = await execFileAsync("gh", ["api", path], { maxBuffer: 5 * 1024 * 1024 });
  return JSON.parse(stdout);
}
