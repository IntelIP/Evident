#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import {
  collectAnalyticsDataset,
  validateAnalyticsDataset,
} from "./lib/analytics.mjs";
import {
  parseCommandOptions,
  reportCliError,
  requireOptions,
} from "./lib/cli-options.mjs";

const ALLOWED_OPTIONS = {
  collect: ["config", "id", "observedAt", "since", "until", "out"],
  check: ["dataset"],
};

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
  const protectedInputs = [
    configPath,
    ...config.repositories.flatMap(providerSnapshotPath),
  ];
  const repositoryRoots = config.repositories.map((repository) => repository.path);
  const outputPath = await assertSafeOutput(options.out, protectedInputs, repositoryRoots);
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

function providerSnapshotPath(repository) {
  if (typeof repository?.providerSnapshot !== "string") return [];
  return [resolve(repository.path, repository.providerSnapshot)];
}

async function assertSafeOutput(output, inputs, repositoryRoots) {
  const outputPath = resolve(output);
  const inputPaths = inputs.map((input) => resolve(input));
  const outputState = await optionalPathState(outputPath);
  assertOutputIsNotSymlink(outputState);
  const inputStates = await Promise.all(inputPaths.map(optionalPathState));
  assertOutputDoesNotAliasInput(outputState, inputStates);
  const candidate = await canonicalCandidatePath(outputPath, outputState);
  const inputCandidates = await Promise.all(inputPaths.map((input, index) =>
    canonicalCandidatePath(input, inputStates[index])
  ));
  assertOutputDoesNotNameInput(candidate, inputCandidates);
  const roots = await Promise.all(repositoryRoots.map((root) => realpath(resolve(root))));
  assertOutputOutsideRepositories(candidate, roots);
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

async function optionalPathState(path) {
  try {
    const [entry, resolvedPath, metadata] = await Promise.all([
      lstat(path),
      realpath(path),
      stat(path),
    ]);
    return {
      symbolicLink: entry.isSymbolicLink(),
      resolvedPath,
      device: metadata.dev,
      inode: metadata.ino,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function canonicalCandidatePath(path, state) {
  if (state !== null) return state.resolvedPath;
  const suffix = [];
  let candidate = path;
  let resolvedPath = await optionalRealpath(candidate);
  while (resolvedPath === null) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("Analytics output has no resolvable parent.");
    suffix.unshift(basename(candidate));
    candidate = parent;
    resolvedPath = await optionalRealpath(candidate);
  }
  return resolve(resolvedPath, ...suffix);
}

async function optionalRealpath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameFile(left, right) {
  if (left === null) return false;
  if (right === null) return false;
  if (left.resolvedPath === right.resolvedPath) return true;
  return sameInode(left, right);
}

function sameInode(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

function pathWithin(candidate, root) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path));
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
