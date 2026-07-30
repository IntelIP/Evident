import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import {
  validateAnalyticsDataset,
} from "../scripts/lib/analytics.mjs";
import {
  renderAnalyticsBaselineReport,
} from "../scripts/lib/analytics-report.mjs";

const execFileAsync = promisify(execFile);
const datasetPath = "reports/analytics/2026-07-28-intb-261-baseline.json";
const reportPath = "reports/analytics/2026-07-28-intb-261-baseline.md";

test("packaged analytics baseline binds current sources and report", async () => {
  const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
  const report = await readFile(reportPath, "utf8");
  validateAnalyticsDataset(dataset);
  assert.equal(report, renderAnalyticsBaselineReport(dataset));
  const result = await execFileAsync(process.execPath, [
    "scripts/check-tabellio-analytics-baseline.mjs",
  ], { cwd: process.cwd() });
  assert.match(result.stdout, /analytics_baseline_ready/);
  console.log(`analytics_baseline_repository_count=${dataset.repositories.length}`);
});

test("npm package includes every baseline validation input", async () => {
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: process.cwd(),
  });
  const files = new Set(JSON.parse(stdout)[0].files.map((file) => file.path));
  const required = [
    ".tabellio/validators.json",
    datasetPath,
    reportPath,
    "reports/analytics/sources/2026-07-28-condere-provider-snapshot.json",
    "reports/analytics/sources/2026-07-28-probanda-provider-snapshot.json",
    "reports/analytics/sources/2026-07-28-tabellio-provider-snapshot.json",
    "reports/analytics/sources/2026-07-28-vaticor-provider-snapshot.json",
  ];
  required.forEach((path) => assert.equal(files.has(path), true, path));
});

test("analytics semantic validation accepts v0.2 provenance fields", async () => {
  const sources = [
    "reports/analytics/sources/2026-07-28-condere-provider-snapshot.json",
    "reports/analytics/sources/2026-07-28-probanda-provider-snapshot.json",
    "reports/analytics/sources/2026-07-28-tabellio-provider-snapshot.json",
    "reports/analytics/sources/2026-07-28-vaticor-provider-snapshot.json",
  ];
  const repositories = [
    "IntelIP/Condere",
    "IntelIP/Probanda",
    "IntelIP/Tabellio",
    "IntelIP/vaticor",
  ];
  const args = [
    "scripts/tabellio-analytics-validator.mjs",
    "--profile", "semantic",
    "--validator-id", "baseline-semantic",
    "--dataset", datasetPath,
    "--expected-digest",
    "8f8071c5797af2c38abea8d81785bff259f9f42ab347ffe535c29e3c5b7fb9d5",
    ...sources.flatMap((source) => ["--source", source]),
    ...repositories.flatMap((repository) => [
      "--required-repository", repository,
    ]),
    "--out", ".artifacts/tabellio/baseline-semantic-test.json",
  ];
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: process.cwd(),
  });
  assert.match(stdout, /"status":"passed"/);
});

test("Buildkite merged-head checkpoint integration remains fail closed", async () => {
  const script = await readFile(
    ".buildkite/scripts/product-validation.sh",
    "utf8",
  );
  assert.match(script, /scripts\/resolve-merged-checkpoint\.mjs/);
  assert.match(script, /Merged checkpoint resolution failed/);
  assert.match(script, /Merged checkpoint fetch failed/);
  assert.match(script, /--checkpoint-head/);
});
