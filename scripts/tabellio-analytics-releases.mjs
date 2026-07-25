#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { linkGitHubReleases } from "./lib/github-release-linker.mjs";

main().catch(reportCliError);

async function main() {
  const options = parseCommandOptions(process.argv.slice(2), {
    link: ["providerSnapshot", "githubReleaseSnapshot", "out"],
  });
  requireOptions(options, ["providerSnapshot", "githubReleaseSnapshot", "out"], "link");
  const providerPath = resolve(options.providerSnapshot);
  const releasePath = resolve(options.githubReleaseSnapshot);
  const outputPath = resolve(options.out);
  if (outputPath === providerPath || outputPath === releasePath) throw new Error("--out must be distinct from both input snapshots.");
  const [providerSnapshot, releaseSnapshot] = await Promise.all([
    readJson(providerPath),
    readJson(releasePath),
  ]);
  const linked = linkGitHubReleases({ providerSnapshot, releaseSnapshot });
  await writeFile(outputPath, `${JSON.stringify(linked, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    status: "github_releases_linked",
    repository: linked.repository,
    linkedReleaseCount: linked.deliveryChanges.filter((change) => change.releasedAt).length,
    out: outputPath,
  }, null, 2));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
