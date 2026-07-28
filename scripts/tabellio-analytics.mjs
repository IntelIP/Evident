#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  collectAnalyticsDataset,
  validateAnalyticsDataset,
} from "./lib/analytics.mjs";
import {
  parseCommandOptions,
  reportCliError,
  requireOptions,
} from "./lib/cli-options.mjs";
import {
  canonicalCandidatePath,
  pathState,
  sameFile,
} from "./lib/output-safety.mjs";

const ALLOWED_OPTIONS = {
  collect: ["config", "id", "observedAt", "since", "until", "out"],
  check: ["dataset"],
};
const execFileAsync = promisify(execFile);

try {
  const options = parseCommandOptions(process.argv.slice(2), ALLOWED_OPTIONS);
  if (options.command === "collect") {
    await collectCommand(options);
  } else {
    await checkCommand(options);
  }
} catch (error) {
  reportCliError(error);
}

async function collectCommand(options) {
  requireOptions(options, ["config", "id", "observedAt", "since", "until", "out"], "collect");
  const configPath = resolve(options.config);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!Array.isArray(config.repositories)) throw new Error("Config repositories must be an array.");
  const repositoryLocations = await Promise.all(config.repositories.map(repositoryLocation));
  const providerInputs = config.repositories.flatMap((repository, index) =>
    providerSnapshotPaths(repository, repositoryLocations[index].root)
  );
  const protectedInputs = [configPath, ...providerInputs];
  const protectedRoots = [...new Set(
    repositoryLocations.flatMap((location) => location.protectedRoots)
  )];
  const outputPath = await assertSafeOutput(options.out, protectedInputs, protectedRoots);
  const dataset = await collectAnalyticsDataset({
    id: options.id,
    observedAt: options.observedAt,
    window: { since: options.since, until: options.until },
    repositories: config.repositories,
  });
  await writeAtomic(outputPath, `${JSON.stringify(dataset, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: "analytics_dataset_ready",
    repositoryCount: dataset.repositories.length,
    digest: dataset.integrity.digest,
  }, null, 2)}\n`);
}

async function checkCommand(options) {
  requireOptions(options, ["dataset"], "check");
  const dataset = JSON.parse(await readFile(resolve(options.dataset), "utf8"));
  validateAnalyticsDataset(dataset);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: "analytics_dataset_valid",
    repositoryCount: dataset.repositories.length,
    digest: dataset.integrity.digest,
  }, null, 2)}\n`);
}

function providerSnapshotPaths(repository, repositoryRoot) {
  if (typeof repository?.providerSnapshot !== "string") return [];
  return [resolve(repositoryRoot, repository.providerSnapshot)];
}

async function repositoryLocation(repository) {
  const repositoryPath = await realpath(resolve(repository.path));
  const { stdout: bareOutput } = await execFileAsync(
    "git",
    ["rev-parse", "--is-bare-repository"],
    { cwd: repositoryPath, encoding: "utf8" },
  );
  if (bareOutput.trim() === "true") {
    return { root: repositoryPath, protectedRoots: [repositoryPath] };
  }
  const { stdout: rootOutput } = await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: repositoryPath, encoding: "utf8" },
  );
  const { stdout: commonDirectoryOutput } = await execFileAsync(
    "git",
    ["rev-parse", "--git-common-dir"],
    { cwd: repositoryPath, encoding: "utf8" },
  );
  const root = await realpath(rootOutput.trim());
  const commonDirectory = await realpath(resolve(repositoryPath, commonDirectoryOutput.trim()));
  return { root, protectedRoots: [root, commonDirectory] };
}

async function assertSafeOutput(output, inputs, repositoryRoots) {
  const outputPath = resolve(output);
  const inputPaths = inputs.map((input) => resolve(input));
  const outputState = await pathState(outputPath);
  assertOutputIsNotSymlink(outputState);
  const inputStates = await Promise.all(inputPaths.map(pathState));
  assertOutputDoesNotAliasInput(outputState, inputStates);
  const candidate = await canonicalCandidatePath(outputPath, outputState);
  const inputCandidates = await Promise.all(inputPaths.map((input, index) =>
    canonicalCandidatePath(input, inputStates[index])
  ));
  assertOutputDoesNotNameInput(candidate, inputCandidates);
  assertOutputOutsideRepositories(candidate, repositoryRoots);
  return outputPath;
}

function assertOutputIsNotSymlink(output) {
  if (output?.symbolicLink) throw new Error("Analytics output must not be a symbolic link.");
}

function assertOutputDoesNotAliasInput(output, inputs) {
  if (inputs.some((input) => sameFile(output, input))) {
    throw new Error("Analytics output must not alias an input.");
  }
}

function assertOutputDoesNotNameInput(output, inputs) {
  if (inputs.includes(output)) {
    throw new Error("Analytics output must not alias an input.");
  }
}

function assertOutputOutsideRepositories(output, roots) {
  if (roots.some((root) => pathWithin(output, root))) {
    throw new Error("Analytics output must remain outside collected repositories.");
  }
}

function pathWithin(candidate, root) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function writeAtomic(outputPath, content) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = resolve(dirname(outputPath), `.tabellio-analytics-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, outputPath);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}
