import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createAnalyticsDataset,
  recomputeDeliveryMetrics,
} from "../scripts/lib/analytics.mjs";
import { canonicalJson } from "../scripts/lib/context-packet.mjs";
import { digestObject } from "../scripts/lib/stack-operation.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const validatorPath = join(projectRoot, "scripts", "tabellio-analytics-validator.mjs");
const execFileAsync = promisify(execFile);
const OBSERVED_AT = "2026-07-27T00:00:00.000Z";
const WINDOW = {
  since: "2026-07-01T00:00:00.000Z",
  until: "2026-07-26T23:59:59.000Z",
};

test("analytics validator schema profile emits passed evidence", async (context) => {
  const fixture = await validatorFixture(context);
  const execution = await runValidator(fixture, "schema");

  assert.equal(execution.exitCode, 0);
  const evidence = await evidenceAt(fixture.out);
  assert.equal(evidence.status, "passed");
  assert.equal(metricValue(evidence, "analytics_validator_schema_pass"), 1);
  assert.deepEqual(evidence.cost, {
    telemetry: "available",
    usd: 0,
    modelCalls: 0,
    toolCalls: 0,
  });
  assert.equal(evidence.artifacts.length, 4);
});

test("analytics validator semantic profile requires exact collected repositories and a linked trace", async (context) => {
  const fixture = await validatorFixture(context);
  const execution = await runValidator(fixture, "semantic");
  const evidence = await evidenceAt(fixture.out);

  assert.equal(execution.exitCode, 0);
  assert.equal(evidence.status, "passed");
  assert.equal(metricValue(evidence, "analytics_repository_count"), 2);
  assert.equal(metricValue(evidence, "analytics_trace_count"), 1);
});

test("analytics validator writes blocked evidence for invalid JSON without copying private text", async (context) => {
  const fixture = await validatorFixture(context);
  const privateValue = "ghp_0123456789abcdef";
  await writeFile(fixture.datasetPath, `{"private":"${privateValue}"`);

  const execution = await runValidator(fixture, "schema");
  const evidence = await evidenceAt(fixture.out);
  const serialized = JSON.stringify(evidence);

  assert.equal(execution.exitCode, 0);
  assert.equal(evidence.status, "blocked");
  assert.match(evidence.summary, /1 invalid or unavailable input/);
  assert.doesNotMatch(serialized, new RegExp(privateValue));
  assert.doesNotMatch(serialized, /Users\/|private\/var|file:/i);
});

test("analytics validator blocks non-contract provider fields", async (context) => {
  const fixture = await validatorFixture(context);
  const source = JSON.parse(await readFile(fixture.sourcePaths[0], "utf8"));
  source.raw = { secret: "provider response" };
  await writeFile(fixture.sourcePaths[0], `${JSON.stringify(source, null, 2)}\n`);

  await runValidator(fixture, "schema");
  assert.equal((await evidenceAt(fixture.out)).status, "blocked");
});

test("analytics validator semantic profile fails a wrong required repository set", async (context) => {
  const fixture = await validatorFixture(context);
  fixture.requiredRepositories = ["IntelIP/Tabellio", "IntelIP/Missing"];

  const execution = await runValidator(fixture, "semantic");
  const evidence = await evidenceAt(fixture.out);

  assert.equal(execution.exitCode, 0);
  assert.equal(evidence.status, "failed");
  assert.equal(metricValue(evidence, "analytics_validator_semantic_pass"), 0);
  assert.equal(metricValue(evidence, "analytics_repository_count"), 2);
});

test("analytics validator semantic profile fails without a linked trace", async (context) => {
  const snapshots = [
    providerSnapshot("IntelIP/Tabellio", "a".repeat(40), { available: false }),
    providerSnapshot("IntelIP/Condere", "b".repeat(40), { available: false }),
  ];
  const fixture = await validatorFixture(context, snapshots);

  await runValidator(fixture, "semantic");
  const evidence = await evidenceAt(fixture.out);
  assert.equal(evidence.status, "failed");
  assert.equal(metricValue(evidence, "analytics_trace_count"), 0);
});

test("analytics validator provider binding rejects mismatched source evidence", async (context) => {
  const fixture = await validatorFixture(context);
  const dataset = JSON.parse(await readFile(fixture.datasetPath, "utf8"));
  dataset.repositories[0].sources.find((source) =>
    source.system === "github"
  ).contentDigest = "f".repeat(64);
  await assertDatasetStatus(fixture, dataset, "workflow", "failed");
});

test("analytics validator filters provider traces to the dataset window", async (context) => {
  const snapshot = providerSnapshot("IntelIP/Tabellio", "a".repeat(40), {
    available: true,
    linked: true,
  });
  snapshot.deliveryChanges.push({
    ...structuredClone(snapshot.deliveryChanges[0]),
    id: "outside-window",
    linkEvidence: "INTB-260 to PR binding",
    planeStoryId: "INTB-260",
    pullRequestNumber: 34,
    storyCreatedAt: "2026-06-20T00:00:00.000Z",
    firstActivityAt: "2026-06-21T00:00:00.000Z",
    mergedAt: "2026-06-22T00:00:00.000Z",
  });
  const fixture = await validatorFixture(context, [snapshot]);

  await runValidator(fixture, "workflow");
  assert.equal((await evidenceAt(fixture.out)).status, "passed");
});

test("analytics validator blocks forged delivery metrics instead of trusting imported values", async (context) => {
  const fixture = await validatorFixture(context);
  const dataset = JSON.parse(await readFile(fixture.datasetPath, "utf8"));
  dataset.repositories[0].metrics.deliveryChangeCount.value = 99;
  resignDataset(dataset);
  await writeFile(fixture.datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);

  await runValidator(fixture, "semantic");
  assert.equal((await evidenceAt(fixture.out)).status, "blocked");
});

test("analytics validator unavailable provider bindings remain valid evidence", async (context) => {
  const snapshots = [
    providerSnapshot("IntelIP/Tabellio", "a".repeat(40), { available: false }),
  ];
  const fixture = await validatorFixture(context, snapshots);

  await runValidator(fixture, "workflow");
  const evidence = await evidenceAt(fixture.out);
  assert.equal(evidence.status, "passed");
  assert.equal(metricValue(evidence, "analytics_snapshot_count"), 1);
});

test("analytics validator provider binding requires a snapshot for provider-backed evidence", async (context) => {
  const fixture = await validatorFixture(context);
  fixture.sourcePaths = fixture.sourcePaths.slice(1);

  await runValidator(fixture, "workflow");
  assert.equal((await evidenceAt(fixture.out)).status, "failed");
});

test("analytics validator requires a snapshot for every required repository", async (context) => {
  const fixture = await validatorFixture(context);
  fixture.sourcePaths = fixture.sourcePaths.slice(0, 1);

  await runValidator(fixture, "semantic");
  assert.equal((await evidenceAt(fixture.out)).status, "failed");
});

test("analytics validator blocks exact-validation statuses without validation evidence", async (context) => {
  const fixture = await validatorFixture(context);
  const dataset = JSON.parse(await readFile(fixture.datasetPath, "utf8"));
  const validation = dataset.repositories[0].sources.find((source) =>
    source.system === "tabellio-validation"
  );
  Object.assign(validation, {
    status: "blocked",
    sourceVersion: null,
    contentDigest: null,
    reason: "Validation evidence is blocked.",
  });
  await assertDatasetStatus(fixture, dataset, "workflow", "blocked");
});

test("analytics validator binds claimed status to exact validation evidence", async (context) => {
  const fixture = await validatorFixture(context);
  const evidence = JSON.parse(await readFile(fixture.validationPaths[0], "utf8"));
  evidence.result.status = "failed";
  evidence.result.commands[0].status = "failed";
  evidence.result.commands[0].exitCode = 1;
  resignValidationResult(evidence.result);
  await writeFile(fixture.validationPaths[0], `${JSON.stringify(evidence, null, 2)}\n`);

  const dataset = JSON.parse(await readFile(fixture.datasetPath, "utf8"));
  dataset.repositories[0].sources.find((source) =>
    source.system === "tabellio-validation"
  ).contentDigest = validationEvidenceDigest(evidence);
  await assertDatasetStatus(fixture, dataset, "workflow", "failed");
});

test("analytics validator requires exact validation evidence input", async (context) => {
  const fixture = await validatorFixture(context);
  fixture.validationPaths = [];

  await runValidator(fixture, "workflow");
  assert.equal((await evidenceAt(fixture.out)).status, "failed");
});

test("analytics validator binds available validation sources without delivery statuses", async (context) => {
  const fixture = await validatorFixture(context);
  const dataset = JSON.parse(await readFile(fixture.datasetPath, "utf8"));
  const snapshot = JSON.parse(await readFile(fixture.sourcePaths[0], "utf8"));
  dataset.repositories[0].deliveryChanges = [];
  dataset.repositories[0].metrics = recomputeDeliveryMetrics(
    dataset.repositories[0],
    dataset.window,
  );
  snapshot.deliveryChanges = [];
  resignDataset(dataset);
  await writeFile(fixture.datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  await writeFile(fixture.sourcePaths[0], `${JSON.stringify(snapshot, null, 2)}\n`);
  fixture.validationPaths = [];

  await runValidator(fixture, "workflow");
  assert.equal((await evidenceAt(fixture.out)).status, "failed");
});

test("analytics validator blocks null validation evidence documents", async (context) => {
  const fixture = await validatorFixture(context);
  await writeFile(fixture.validationPaths[0], "null\n");

  await runValidator(fixture, "workflow");
  assert.equal((await evidenceAt(fixture.out)).status, "blocked");
});

test("analytics validator evidence summary redacts credential and local path inputs", async (context) => {
  const fixture = await validatorFixture(context);
  for (const privateValue of [
    "api_key=private-value",
    "/Users/private/provider.json",
    "C:\\Users\\private\\provider.json",
    "../private/provider.json",
  ]) {
    const dataset = JSON.parse(await readFile(fixture.originalDatasetPath, "utf8"));
    const source = dataset.repositories[1].sources.find((entry) => entry.system === "plane");
    source.reason = privateValue;
    resignDataset(dataset);
    await writeFile(fixture.datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);

    await runValidator(fixture, "security");
    const evidence = await evidenceAt(fixture.out);
    assert.notEqual(evidence.status, "passed");
    assert.equal(JSON.stringify(evidence).includes(privateValue), false);
  }
});

test("analytics validator output cannot alias or link an input", async (context) => {
  const fixture = await validatorFixture(context);
  const original = await readFile(fixture.datasetPath, "utf8");

  fixture.out = fixture.datasetPath;
  const direct = await runValidator(fixture, "schema");
  assert.notEqual(direct.exitCode, 0);
  assert.equal(await readFile(fixture.datasetPath, "utf8"), original);

  fixture.out = join(fixture.root, "hardlink.json");
  await link(fixture.datasetPath, fixture.out);
  const hardlink = await runValidator(fixture, "schema");
  assert.notEqual(hardlink.exitCode, 0);

  await rm(fixture.out);
  await symlink(fixture.datasetPath, fixture.out);
  const symbolic = await runValidator(fixture, "schema");
  assert.notEqual(symbolic.exitCode, 0);

  await rm(fixture.out);
  const missingTarget = join(fixture.root, "missing-target.json");
  await symlink(missingTarget, fixture.out);
  const dangling = await runValidator(fixture, "schema");
  assert.notEqual(dangling.exitCode, 0);
  await assert.rejects(readFile(missingTarget));

  await rm(fixture.out);
  const protectedTarget = join(fixture.root, "protected-target.json");
  await rm(fixture.datasetPath);
  await symlink(protectedTarget, fixture.datasetPath);
  fixture.out = protectedTarget;
  const danglingInput = await runValidator(fixture, "schema");
  assert.notEqual(danglingInput.exitCode, 0);
  await assert.rejects(readFile(protectedTarget));
});

test("analytics validator emits blocked evidence for inaccessible input paths", async (context) => {
  const fixture = await validatorFixture(context);
  const regularFile = join(fixture.root, "not-a-directory");
  await writeFile(regularFile, "regular file");
  fixture.datasetPath = join(regularFile, "dataset.json");

  const execution = await runValidator(fixture, "schema");
  assert.equal(execution.exitCode, 0);
  assert.equal((await evidenceAt(fixture.out)).status, "blocked");
});

test("analytics validator evidence mode preserves failed output", async (context) => {
  const fixture = await validatorFixture(context);
  fixture.requiredRepositories = ["IntelIP/Missing"];

  const evidenceMode = await runValidator(fixture, "semantic");
  assert.equal(evidenceMode.exitCode, 0);
  assert.equal((await evidenceAt(fixture.out)).status, "failed");

  fixture.exitMode = null;
  const normalMode = await runValidator(fixture, "semantic");
  assert.equal(normalMode.exitCode, 1);
  assert.equal((await evidenceAt(fixture.out)).status, "failed");
});

test("analytics validator rejects unsafe evidence identifiers", async (context) => {
  const fixture = await validatorFixture(context);
  fixture.validatorId = "../private/validator";

  const execution = await runValidator(fixture, "schema");
  assert.notEqual(execution.exitCode, 0);
});

test("analytics validator operational profile stays within local projection budget", async (context) => {
  const fixture = await validatorFixture(context);

  await runValidator(fixture, "operational");
  const evidence = await evidenceAt(fixture.out);
  const duration = metricValue(evidence, "analytics_projection_25x_duration_ms");
  assert.equal(evidence.status, "passed");
  assert.ok(duration <= 1_000);
  console.log(`analytics_projection_25x_duration_ms=${duration}`);
});

test("analytics validator security profile passes portable decoded and raw values", async (context) => {
  const fixture = await validatorFixture(context);

  await runValidator(fixture, "security");
  const evidence = await evidenceAt(fixture.out);
  assert.equal(evidence.status, "passed");
  assert.equal(metricValue(evidence, "analytics_validator_security_pass"), 1);
});

async function validatorFixture(context, snapshots = null) {
  const root = await mkdtemp(join(tmpdir(), "tabellio-validator-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const values = snapshots ?? [
    providerSnapshot("IntelIP/Tabellio", "a".repeat(40), { available: true, linked: true }),
    providerSnapshot("IntelIP/Condere", "b".repeat(40), { available: false }),
  ];
  const validationEvidence = values.flatMap(validationEvidenceForSnapshot);
  const evidenceByRepository = new Map(
    validationEvidence.map((value) => [value.repository.toLowerCase(), value])
  );
  const dataset = datasetFromSnapshots(values, evidenceByRepository);
  const datasetPath = join(root, "dataset.json");
  const originalDatasetPath = join(root, "original-dataset.json");
  const sourcePaths = [];
  const validationPaths = [];
  await writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  await writeFile(originalDatasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  for (const [index, snapshot] of values.entries()) {
    const sourcePath = join(root, `provider-${index + 1}.json`);
    await writeFile(sourcePath, `${JSON.stringify(snapshot, null, 2)}\n`);
    sourcePaths.push(sourcePath);
  }
  for (const [index, evidence] of validationEvidence.entries()) {
    const validationPath = join(root, `validation-${index + 1}.json`);
    await writeFile(validationPath, `${JSON.stringify(evidence, null, 2)}\n`);
    validationPaths.push(validationPath);
  }
  return {
    root,
    datasetPath,
    originalDatasetPath,
    sourcePaths,
    validationPaths,
    out: join(root, "evidence.json"),
    requiredRepositories: values.map((snapshot) => snapshot.repository),
    exitMode: "evidence",
  };
}

function datasetFromSnapshots(snapshots, evidenceByRepository) {
  return createAnalyticsDataset({
    id: "INTB-261-p2",
    observedAt: OBSERVED_AT,
    window: WINDOW,
    repositories: snapshots.map((snapshot, index) => repositoryFromSnapshot(
      snapshot,
      `repository-${index + 1}`,
      evidenceByRepository.get(snapshot.repository.toLowerCase()),
    )),
  });
}

function repositoryFromSnapshot(snapshot, id, validationEvidence) {
  const providerSources = Object.entries(snapshot.sources).map(([system, source]) =>
    source.status === "available"
      ? availableDatasetSource(id, system, snapshot.capturedAt, source.version, canonicalJson(source))
      : unavailableDatasetSource(id, system, snapshot.capturedAt, source)
  );
  const deliveryChanges = snapshot.deliveryChanges.map((change) => ({
    ...structuredClone(change),
    releasedAt: null,
  }));
  const sources = [
    availableDatasetSource(
      id,
      "git",
      OBSERVED_AT,
      snapshot.headCommit,
      canonicalJson({ headCommit: snapshot.headCommit }),
    ),
    ...providerSources,
  ];
  if (deliveryChanges.some((change) => change.validationStatus !== "unavailable")) {
    sources.push(availableDatasetSource(
      id,
      "tabellio-validation",
      OBSERVED_AT,
      snapshot.headCommit,
      canonicalJson({
        records: [validationEvidence.result],
        version: validationEvidence.controlVersion,
      }),
    ));
  }
  return {
    id,
    canonicalRepositoryId: snapshot.repository,
    headCommit: snapshot.headCommit,
    headCommittedAt: "2026-07-24T00:00:00.000Z",
    branch: "main",
    sources,
    metrics: {},
    deliveryChanges,
  };
}

function validationEvidenceForSnapshot(snapshot) {
  const status = snapshot.deliveryChanges
    .map((change) => change.validationStatus)
    .find((value) => value !== "unavailable");
  if (status === undefined) return [];
  return [{
    schemaVersion: "tabellio-analytics-validation-evidence/v0.1",
    repository: snapshot.repository,
    controlVersion: "d".repeat(snapshot.headCommit.length),
    result: validationResult(snapshot.repository, snapshot.headCommit, status),
  }];
}

function validationResult(repository, headCommit, status) {
  const commandStatus = status === "passed" ? "passed" : "failed";
  const result = {
    schemaVersion: "tabellio-validation-result/v0.1",
    runId: `validation-${status}`,
    repository: { id: `github.com/${repository}` },
    revision: {
      baseCommit: "c".repeat(headCommit.length),
      mergeBase: "c".repeat(headCommit.length),
      headCommit,
    },
    suite: {
      id: "analytics-test",
      manifestPath: "tabellio.validation.json",
      manifestDigest: "e".repeat(64),
    },
    runner: { id: "test", runtime: "node-test" },
    status,
    checkpoints: ["checkpoint-001"],
    commands: [{
      id: "analytics",
      argv: ["node", "--test"],
      cwd: ".",
      required: true,
      status: commandStatus,
      exitCode: commandStatus === "passed" ? 0 : 1,
      signal: null,
      durationMs: 1,
      stdout: emptyOutput(),
      stderr: emptyOutput(),
      startedAt: "2026-07-20T00:00:00.000Z",
      completedAt: "2026-07-20T00:01:00.000Z",
      error: null,
    }],
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:01:00.000Z",
  };
  resignValidationResult(result);
  return result;
}

function emptyOutput() {
  return {
    bytes: 0,
    digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    tail: "",
    truncated: false,
  };
}

function resignValidationResult(result) {
  delete result.integrity;
  result.integrity = { algorithm: "sha256", digest: digestObject(result) };
}

function validationEvidenceDigest(evidence) {
  return sha256(canonicalJson({
    records: [evidence.result],
    version: evidence.controlVersion,
  }));
}

function availableDatasetSource(id, system, observedAt, sourceVersion, content) {
  return {
    id: `${id}:${system}`,
    system,
    status: "available",
    observedAt,
    sourceVersion,
    contentDigest: sha256(content),
    reason: null,
  };
}

function unavailableDatasetSource(id, system, observedAt, source) {
  return {
    id: `${id}:${system}`,
    system,
    status: source.status,
    observedAt,
    sourceVersion: null,
    contentDigest: null,
    reason: source.reason,
  };
}

function providerSnapshot(repository, headCommit, { available, linked = false }) {
  const sources = Object.fromEntries(
    ["plane", "github", "github-actions", "buildkite"].map((system) => [
      system,
      available
        ? { status: "available", version: `2026-07-25T0${system.length % 9}:00:00.000Z` }
        : { status: "unavailable", reason: "Provider evidence is unavailable." },
    ])
  );
  sources.plane.workspace = "intelip";
  return {
    schemaVersion: "tabellio-analytics-provider-snapshot/v0.1",
    repository,
    headCommit,
    capturedAt: "2026-07-26T00:00:00.000Z",
    sources,
    deliveryChanges: linked ? [{
      id: "change-1",
      linkBasis: "explicit",
      linkEvidence: "INTB-261 to PR binding",
      planeStoryId: "INTB-261",
      pullRequestNumber: 35,
      storyCreatedAt: "2026-07-20T00:00:00.000Z",
      firstActivityAt: "2026-07-21T00:00:00.000Z",
      mergedAt: "2026-07-22T00:00:00.000Z",
      headCommit,
      validationStatus: "passed",
      hostedStatus: "passed",
    }] : [],
  };
}

async function runValidator(fixture, profile) {
  const args = validatorArgs(fixture, profile);
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: projectRoot,
      encoding: "utf8",
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    return failedExecution(error);
  }
}

function validatorArgs(fixture, profile) {
  const sourceArgs = fixture.sourcePaths.flatMap((path) => ["--source", path]);
  const validationArgs = fixture.validationPaths.flatMap(
    (path) => ["--validation-evidence", path]
  );
  const repositoryArgs = fixture.requiredRepositories.flatMap(
    (repository) => ["--required-repository", repository]
  );
  const exitModeArgs = fixture.exitMode === null
    ? []
    : ["--exit-mode", fixture.exitMode];
  return [
    validatorPath,
    "--profile", profile,
    "--validator-id", fixture.validatorId ?? `analytics-validator-${profile}`,
    "--dataset", fixture.datasetPath,
    "--out", fixture.out,
    ...sourceArgs,
    ...validationArgs,
    ...repositoryArgs,
    ...exitModeArgs,
  ];
}

function failedExecution(error) {
  return {
    stdout: error.stdout ?? "",
    stderr: error.stderr ?? "",
    exitCode: error.code,
  };
}

async function evidenceAt(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function metricValue(evidence, name) {
  return evidence.metrics.find((metric) => metric.name === name)?.value;
}

function resignDataset(dataset) {
  delete dataset.integrity;
  dataset.integrity = {
    algorithm: "sha256",
    digest: sha256(canonicalJson(dataset)),
  };
}

async function assertDatasetStatus(fixture, dataset, profile, status) {
  resignDataset(dataset);
  await writeFile(fixture.datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  await runValidator(fixture, profile);
  assert.equal((await evidenceAt(fixture.out)).status, status);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
