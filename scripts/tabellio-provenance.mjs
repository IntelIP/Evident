#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseCommandOptions, requireOptions, writeJsonOutput } from "./lib/cli-options.mjs";
import { LocalProvenanceStore } from "./lib/local-provenance-store.mjs";
import { assembleLineage, buildReviewPacket, captureCandidate, evaluateLineage, verifyLineage } from "./lib/provenance-ledger.mjs";
import { captureGitSource, collectProvenanceSources } from "./lib/provenance-sources.mjs";

main().catch(() => {
  // Provider content and database errors must not escape through CLI diagnostics.
  process.stderr.write(JSON.stringify({ status: "blocked", reason: "Invalid input or unavailable local evidence. Check the input contract and database access." }) + "\n");
  process.exitCode = 1;
});

async function readInput(path) {
  const buffer = await readFile(path);
  if (buffer.byteLength > 2 * 1024 * 1024) throw new Error("Input exceeds 2 MiB.");
  return JSON.parse(buffer.toString("utf8"));
}

async function main() {
  const query = ["databaseUrl", "digest", "projectKey", "repositoryId"];
  const options = parseCommandOptions(process.argv.slice(2), {
    capture: ["repo", "projectKey", "repositoryId", "base", "head", "out"],
    "import-sources": ["input", "repo", "databaseUrl", "now", "out"],
    import: ["input", "databaseUrl", "out"],
    replay: ["input", "databaseUrl", "out"],
    show: [...query, "out"],
    review: [...query, "repo", "base", "head", "now", "out"],
    packet: [...query, "repo", "base", "head", "now", "out"],
  });
  if (options.command === "import-sources") {
    await importSources(options);
    return;
  }
  if (options.command === "capture") {
    requireOptions(options, ["repo", "projectKey", "repositoryId"], "capture");
    await writeJsonOutput(await captureCandidate(options), options.out);
    return;
  }
  if (["import", "replay"].includes(options.command)) {
    requireOptions(options, ["input", "databaseUrl"], options.command);
    const input = await readInput(options.input);
    const lineage = input.schemaVersion ? verifyLineage(input) : assembleLineage(input);
    const store = new LocalProvenanceStore({ databaseUrl: options.databaseUrl }); await store.migrate();
    const digest = await store.putLineage(lineage);
    await writeJsonOutput({ status: "stored", candidate: lineage.candidate, digest }, options.out);
    return;
  }
  requireOptions(options, query, options.command);
  const store = new LocalProvenanceStore({ databaseUrl: options.databaseUrl }); await store.migrate();
  const lineage = await store.getLineage(options);
  if (!lineage) {
    await writeJsonOutput({ status: "blocked", reason: "No matching lineage in this project and repository. Import source evidence first." }, options.out);
    process.exitCode = 1;
    return;
  }
  if (options.command === "show") {
    await writeJsonOutput(lineage, options.out);
    return;
  }
  requireOptions(options, ["repo"], options.command);
  const candidate = await captureCandidate(options);
  const evaluation = { candidate, now: options.now ?? new Date().toISOString() };
  const result = options.command === "packet" ? buildReviewPacket(lineage, evaluation) : evaluateLineage(lineage, evaluation);
  await writeJsonOutput(result, options.out);
  if (result.status !== "passed") process.exitCode = 1;
}

async function importSources(options) {
  requireOptions(options, ["input", "repo", "databaseUrl"], "import-sources");
  const input = await readInput(options.input);
  const snapshots = { ...input.snapshots, git: await captureGitSource({ repo: options.repo, candidate: input.candidate, capturedAt: options.now }) };
  const readers = Object.fromEntries(Object.entries(snapshots).map(([source, snapshot]) => [source, async () => snapshot]));
  const result = await collectProvenanceSources({ candidate: input.candidate, selection: input.selection, readers, now: options.now });
  const store = new LocalProvenanceStore({ databaseUrl: options.databaseUrl });
  await store.migrate();
  await store.putLineage(result.lineage);
  const status = result.sources.every((source) => source.status === "present") ? "stored" : "blocked";
  await writeJsonOutput({ status, ...result }, options.out);
  if (status === "blocked") process.exitCode = 1;
}
