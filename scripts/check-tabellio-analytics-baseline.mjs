#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  validateAnalyticsDataset,
} from "./lib/analytics.mjs";
import {
  renderAnalyticsBaselineReport,
} from "./lib/analytics-report.mjs";
import { canonicalJson } from "./lib/context-packet.mjs";
import {
  canonicalRepositoryId,
  validateProviderSnapshot,
} from "./lib/portable-evidence.mjs";

const datasetPath = resolve(
  "reports/analytics/2026-07-28-intb-261-baseline.json",
);
const reportPath = resolve(
  "reports/analytics/2026-07-28-intb-261-baseline.md",
);
const sourcesPath = resolve("reports/analytics/sources");

try {
  const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
  validateAnalyticsDataset(dataset);
  const report = await readFile(reportPath, "utf8");
  if (report !== renderAnalyticsBaselineReport(dataset)) {
    throw new Error("Analytics baseline report does not match its dataset.");
  }
  const snapshots = await readProviderSnapshots();
  assertSnapshotSet(dataset, snapshots);
  console.log(JSON.stringify({
    ok: true,
    status: "analytics_baseline_ready",
    repositoryCount: dataset.repositories.length,
    snapshotCount: snapshots.length,
    digest: dataset.integrity.digest,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
}

async function readProviderSnapshots() {
  const names = (await readdir(sourcesPath))
    .filter((name) => name.endsWith("-provider-snapshot.json"))
    .sort();
  return Promise.all(names.map(async (name) =>
    JSON.parse(await readFile(resolve(sourcesPath, name), "utf8"))));
}

function assertSnapshotSet(dataset, snapshots) {
  const repositories = new Map(dataset.repositories.map((repository) => [
    canonicalRepositoryId(repository.canonicalRepositoryId),
    repository,
  ]));
  assertSnapshotCount(snapshots, repositories);
  for (const snapshot of snapshots) {
    const repositoryId = canonicalRepositoryId(snapshot.repository);
    const repository = requiredRepository(repositories, repositoryId);
    assertSnapshotBinding(dataset, repository, snapshot);
    repositories.delete(repositoryId);
  }
  assertNoMissingSnapshots(repositories);
}

function assertSnapshotCount(snapshots, repositories) {
  if (snapshots.length === repositories.size) return;
  throw new Error("Analytics baseline requires one snapshot per repository.");
}

function requiredRepository(repositories, repositoryId) {
  const repository = repositories.get(repositoryId);
  if (repository) return repository;
  throw new Error("Provider snapshot has no baseline repository.");
}

function assertNoMissingSnapshots(repositories) {
  if (repositories.size !== 0) {
    throw new Error("Baseline repository lacks a provider snapshot.");
  }
}

function assertSnapshotBinding(dataset, repository, snapshot) {
  const errors = validateProviderSnapshot(snapshot, {
    repository: repository.canonicalRepositoryId,
    headCommit: repository.headCommit,
    observedAt: dataset.observedAt,
  });
  if (errors.length) throw new Error("Provider snapshot contract is invalid.");
  for (const system of ["plane", "github", "github-actions", "buildkite"]) {
    assertSourceBinding(repository, snapshot, system);
  }
  const expectedChanges = snapshot.deliveryChanges
    .filter((change) => withinWindow(change, dataset.window))
    .map(normalizeChange)
    .sort(compareId);
  const actualChanges = structuredClone(repository.deliveryChanges).sort(compareId);
  if (canonicalJson(actualChanges) !== canonicalJson(expectedChanges)) {
    throw new Error("Baseline delivery changes do not match provider snapshots.");
  }
}

function assertSourceBinding(repository, snapshot, system) {
  const actual = repository.sources.find((source) => source.system === system);
  const expected = snapshot.sources[system];
  if (!actual) throw new Error("Baseline provider source is missing.");
  if (actual.status !== expected.status) {
    throw new Error("Baseline provider source status does not match.");
  }
  if (expected.status === "available") {
    assertAvailableSourceBinding(actual, expected);
    return;
  }
  assertUnavailableSourceBinding(actual, expected);
}

function assertAvailableSourceBinding(actual, expected) {
  const digest = createHash("sha256")
    .update(canonicalJson(expected))
    .digest("hex");
  if (actual.sourceVersion !== expected.version) {
    throw new Error("Baseline provider source version does not match.");
  }
  if (actual.contentDigest !== digest) {
    throw new Error("Baseline provider source digest does not match.");
  }
}

function assertUnavailableSourceBinding(actual, expected) {
  if (actual.reason === expected.reason) return;
  throw new Error("Baseline unavailable reason does not match its source.");
}

function withinWindow(change, window) {
  const timestamp =
    change.mergedAt ?? change.firstActivityAt ?? change.storyCreatedAt;
  if (timestamp === null) return false;
  return timestampWithinWindow(timestamp, window);
}

function timestampWithinWindow(timestamp, window) {
  const value = Date.parse(timestamp);
  const bounds = [Date.parse(window.since), Date.parse(window.until)];
  return value >= bounds[0] && value <= bounds[1];
}

function normalizeChange(change) {
  const normalized = structuredClone(change);
  delete normalized.mergeCommit;
  delete normalized.releaseCommit;
  normalized.releasedAt ??= null;
  return normalized;
}

function compareId(left, right) {
  return left.id.localeCompare(right.id);
}
