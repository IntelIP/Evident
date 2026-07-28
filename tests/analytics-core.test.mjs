import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  collectAnalyticsDataset,
  createAnalyticsDataset,
  recomputeDeliveryMetrics,
  validateAnalyticsDataset,
} from "../scripts/lib/analytics.mjs";
import { digestObject } from "../scripts/lib/stack-operation.mjs";

const HEAD = "a".repeat(40);
const OBSERVED_AT = "2026-07-27T00:00:00.000Z";
const execFileAsync = promisify(execFile);

test("analytics core binds exact Git evidence and recomputes delivery metrics", () => {
  const repository = repositoryFixture();
  const dataset = createAnalyticsDataset({
    id: "INTB-261-p1b",
    observedAt: OBSERVED_AT,
    window: {
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-26T00:00:00.000Z",
    },
    repositories: [repository],
  });

  assert.equal(validateAnalyticsDataset(dataset), dataset);
  assert.equal(dataset.repositories[0].metrics.deliveryChangeCount.value, 1);
  assert.equal(dataset.repositories[0].metrics.taskToPrTraceability.value, 1);
  assert.equal(dataset.repositories[0].metrics.leadTimeHours.value, 48);
  assert.equal(dataset.repositories[0].metrics.cycleTimeHours.value, 24);
  assert.equal(dataset.repositories[0].metrics.ciDisagreementRate.value, 0);
  assert.equal(dataset.repositories[0].metrics.releaseLagHours.value, 24);
  for (const metric of [
    dataset.repositories[0].metrics.leadTimeHours,
    dataset.repositories[0].metrics.cycleTimeHours,
    dataset.repositories[0].metrics.releaseLagHours,
  ]) {
    assert.equal(metric.numerator, null);
    assert.equal(metric.denominator, null);
  }
});

test("analytics core preserves unavailable evidence instead of manufacturing zero", () => {
  const repository = repositoryFixture();
  repository.sources = repository.sources.map((source) =>
    source.system === "plane"
      ? {
          ...source,
          status: "unavailable",
          sourceVersion: null,
          contentDigest: null,
          reason: "provider unavailable",
        }
      : source
  );
  repository.deliveryChanges = [];

  const metrics = recomputeDeliveryMetrics(repository);
  assert.equal(metrics.deliveryChangeCount.status, "unavailable");
  assert.equal(metrics.deliveryChangeCount.value, null);
  assert.equal(metrics.taskToPrTraceability.status, "unavailable");
  assert.notEqual(metrics.deliveryChangeCount.value, 0);
});

test("analytics core preserves opaque provider versions that resemble years", () => {
  const repository = repositoryFixture();
  repository.sources.find((source) => source.system === "github").sourceVersion = "build-3000";
  const dataset = createAnalyticsDataset({
    id: "INTB-261-p1b",
    observedAt: OBSERVED_AT,
    window: {
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-26T00:00:00.000Z",
    },
    repositories: [repository],
  });
  assert.equal(validateAnalyticsDataset(dataset), dataset);
});

test("analytics core rejects stale, unsafe, and contradictory imported evidence", () => {
  const cases = [
    ["Git head mismatch", (dataset) => {
      dataset.repositories[0].sources.find((source) => source.system === "git").sourceVersion = "b".repeat(40);
    }, /does not match headCommit/],
    ["unsafe source reason", (dataset) => {
      blockPlaneSource(dataset, "token=gho_0123456789abcdef");
    }, /safe reason/],
    ["future provider version", (dataset) => {
      dataset.repositories[0].sources.find((source) => source.system === "github").sourceVersion =
        "2099-01-01T00:00:00Z";
    }, /later than its observation/],
    ["forged metric", (dataset) => {
      dataset.repositories[0].metrics.deliveryChangeCount.value = 99;
    }, /metrics contradict/],
    ["unsafe relationship", (dataset) => {
      dataset.repositories[0].deliveryChanges[0].planeStoryId = "file:///private";
    }, /linked change requires/],
    ["extra source payload", (dataset) => {
      dataset.repositories[0].sources[0].raw = "private";
    }, /not allowed/],
    ["missing-prefix GitHub token", (dataset) => {
      blockPlaneSource(dataset, "github_pat_0123456789abcdef");
    }, /safe reason/],
    ["project token", (dataset) => {
      dataset.repositories[0].deliveryChanges[0].linkEvidence = "sk-proj_0123456789abcdef";
    }, /linkEvidence is unsafe/],
    ["local path in provider ETag", (dataset) => {
      dataset.repositories[0].sources.find((source) => source.system === "github").sourceVersion =
        "W/\"/Users/private/provider-cache\"";
    }, /provider source version is unsafe/],
    ["missing source observation", (dataset) => {
      delete dataset.repositories[0].sources[0].observedAt;
    }, /observedAt is invalid/],
    ["delivery head mismatch", (dataset) => {
      dataset.repositories[0].deliveryChanges[0].headCommit = "b".repeat(40);
    }, /does not match the repository head/],
    ["non-canonical metric state", (dataset) => {
      dataset.repositories[0].metrics.deliveryChangeCount.status = "not_applicable";
    }, /metrics contradict/],
    ["unbound validation status", (dataset) => {
      const source = dataset.repositories[0].sources.find((entry) => entry.system === "tabellio-validation");
      Object.assign(source, {
        status: "unavailable",
        sourceVersion: null,
        contentDigest: null,
        reason: "validation unavailable",
      });
    }, /validationStatus requires available exact validation evidence/],
    ["stale validation source", (dataset) => {
      dataset.repositories[0].sources.find((source) =>
        source.system === "tabellio-validation"
      ).sourceVersion = "b".repeat(40);
    }, /Validation source version does not match headCommit/],
    ["stale review source", (dataset) => {
      dataset.repositories[0].sources.push(source("tabellio-review", "b".repeat(40)));
    }, /Review source version does not match headCommit/],
    ["missing provider version", (dataset) => {
      dataset.repositories[0].sources.find((source) =>
        source.system === "github"
      ).sourceVersion = null;
    }, /provider source version is unsafe/],
    ["missing observation window", (dataset) => {
      delete dataset.window;
    }, /Dataset observation window is invalid/],
    ["null observation window", (dataset) => {
      dataset.window = null;
    }, /Dataset observation window is invalid/],
    ["non-array sources", (dataset) => {
      dataset.repositories[0].sources = {};
    }, /sources are required/],
    ["uppercase file URI reason", (dataset) => {
      blockPlaneSource(dataset, "FILE:///Users/private/evidence.json");
    }, /safe reason/],
    ["extra integrity payload", (dataset) => {
      dataset.integrity.ghp_0123456789abcdef = "/Users/private";
    }, /integrity contains a field that is not allowed/],
    ["mixed Git object formats", (dataset) => {
      dataset.repositories[0].sources.push(source("tabellio-review", "b".repeat(64)));
    }, /Git-backed source object format does not match headCommit/],
    ["unsafe custom source version", (dataset) => {
      dataset.repositories[0].sources.push(source("custom-provider", "ghp_0123456789abcdef"));
    }, /provider source version is unsafe/],
    ["Git-backed source without repository head", (dataset) => {
      const gitSource = dataset.repositories[0].sources.find((source) => source.system === "git");
      Object.assign(gitSource, {
        status: "unavailable",
        sourceVersion: null,
        contentDigest: null,
        reason: "Git evidence unavailable",
      });
      dataset.repositories[0].headCommit = null;
      dataset.repositories[0].headCommittedAt = null;
      dataset.repositories[0].branch = null;
      dataset.repositories[0].deliveryChanges = [];
      dataset.repositories[0].sources.push(source("tabellio-review", "b".repeat(40)));
      dataset.repositories[0].metrics = recomputeDeliveryMetrics(dataset.repositories[0]);
    }, /Available Git-backed source requires a repository headCommit/],
  ];

  for (const [name, mutate, expected] of cases) {
    const dataset = createDatasetFixture();
    mutate(dataset);
    assert.throws(() => validateAnalyticsDataset(dataset), expected, name);
  }
});

test("analytics errors redact rejected field names", () => {
  const dataset = createDatasetFixture();
  dataset.repositories[0].sources[0].ghp_0123456789abcdef = "private";
  assert.throws(
    () => validateAnalyticsDataset(dataset),
    (error) => {
      assert.match(error.message, /contains a field that is not allowed/);
      assert.doesNotMatch(error.message, /ghp_0123456789abcdef/);
      return true;
    },
  );
});

test("analytics core rejects duplicate delivery relationships", () => {
  const dataset = createDatasetFixture();
  const duplicate = structuredClone(dataset.repositories[0].deliveryChanges[0]);
  duplicate.id = "change-2";
  dataset.repositories[0].deliveryChanges.push(duplicate);
  assert.throws(
    () => validateAnalyticsDataset(dataset),
    /duplicates Plane and pull-request relationship/,
  );
});

test("analytics core filters collection and rejects imported rows outside the window", () => {
  const repository = repositoryFixture();
  const oldChange = structuredClone(repository.deliveryChanges[0]);
  Object.assign(oldChange, {
    id: "change-old",
    planeStoryId: "INTB-200",
    pullRequestNumber: 20,
    storyCreatedAt: "2026-01-20T00:00:00.000Z",
    firstActivityAt: "2026-01-21T00:00:00.000Z",
    mergedAt: "2026-01-22T00:00:00.000Z",
    releasedAt: "2026-01-23T00:00:00.000Z",
  });
  repository.deliveryChanges.push(oldChange);

  const dataset = createAnalyticsDataset({
    id: "INTB-261-p1b",
    observedAt: OBSERVED_AT,
    window: {
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-26T00:00:00.000Z",
    },
    repositories: [repository],
  });
  assert.deepEqual(dataset.repositories[0].deliveryChanges.map((change) => change.id), ["change-1"]);
  assert.equal(dataset.repositories[0].metrics.deliveryChangeCount.value, 1);

  dataset.repositories[0].deliveryChanges.push(oldChange);
  assert.throws(() => validateAnalyticsDataset(dataset), /outside the dataset observation window/);
});

test("analytics core keeps a source-backed zero count measured", () => {
  const repository = repositoryFixture();
  repository.deliveryChanges = [];
  const metrics = recomputeDeliveryMetrics(repository);
  assert.deepEqual(metrics.deliveryChangeCount, {
    status: "measured",
    value: 0,
    unit: "count",
    reason: null,
    numerator: null,
    denominator: null,
  });
});

test("analytics collector derives canonical identity and never exports remote credentials", async (context) => {
  const fixture = await gitRepositoryFixture(context);
  await git(fixture.repository, [
    "remote",
    "add",
    "origin",
    "https://x-access-token:ghp_0123456789abcdef@github.com/IntelIP/Example.git",
  ]);
  const dataset = await collectFixture(fixture.repository);
  assert.equal(dataset.repositories[0].canonicalRepositoryId, "IntelIP/Example");
  assert.doesNotMatch(JSON.stringify(dataset), /x-access-token|ghp_0123456789abcdef/);
});

test("analytics collector derives the same local identity through filesystem aliases", async (context) => {
  const fixture = await gitRepositoryFixture(context);
  const alias = join(fixture.root, "repository-alias");
  await symlink(fixture.repository, alias);
  const direct = await collectFixture(fixture.repository);
  const linked = await collectFixture(alias);
  const subdirectory = join(fixture.repository, "src");
  await mkdir(subdirectory);
  const nested = await collectFixture(subdirectory);
  assert.equal(direct.repositories[0].canonicalRepositoryId, linked.repositories[0].canonicalRepositoryId);
  assert.equal(direct.repositories[0].canonicalRepositoryId, nested.repositories[0].canonicalRepositoryId);
  assert.match(direct.repositories[0].canonicalRepositoryId, /^local\/[0-9a-f]{16}$/);
});

test("analytics collector distinguishes local repositories with the same directory name", async (context) => {
  const first = await gitRepositoryFixture(context);
  const second = await gitRepositoryFixture(context);
  const dataset = await collectAnalyticsDataset({
    id: "INTB-261-p1b",
    observedAt: OBSERVED_AT,
    window: {
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-26T00:00:00.000Z",
    },
    repositories: [
      { id: "first", path: first.repository },
      { id: "second", path: second.repository },
    ],
  });
  const identities = dataset.repositories.map((repository) => repository.canonicalRepositoryId);
  assert.equal(new Set(identities).size, 2);
});

test("analytics collector encodes valid non-portable Git branch names", async (context) => {
  const fixture = await gitRepositoryFixture(context);
  await git(fixture.repository, ["switch", "-c", "feature/a+b"]);
  const dataset = await collectFixture(fixture.repository);
  assert.match(dataset.repositories[0].branch, /^branch\/[0-9a-f]{16}$/);
});

test("analytics collector accepts a bound sanitized provider snapshot", async (context) => {
  const fixture = await githubRepositoryFixture(context);
  const { head } = fixture;
  const providerPath = join(fixture.root, "provider.json");
  await writeFile(providerPath, `${JSON.stringify(providerSnapshot(head), null, 2)}\n`);
  const dataset = await collectAnalyticsDataset({
    id: "INTB-261-p1b",
    observedAt: OBSERVED_AT,
    window: {
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-26T00:00:00.000Z",
    },
    repositories: [{
      id: "fixture",
      path: fixture.repository,
      providerSnapshot: providerPath,
    }],
  });
  assert.equal(dataset.repositories[0].metrics.deliveryChangeCount.value, 1);
  assert.equal(dataset.repositories[0].deliveryChanges[0].releasedAt, null);
  assert.equal(validateAnalyticsDataset(dataset), dataset);
});

test("analytics collector exports provider sources deterministically", async (context) => {
  const fixture = await githubRepositoryFixture(context);
  const { head } = fixture;
  const firstPath = join(fixture.root, "provider-first.json");
  const secondPath = join(fixture.root, "provider-second.json");
  const firstSnapshot = providerSnapshot(head);
  const secondSnapshot = structuredClone(firstSnapshot);
  secondSnapshot.sources = Object.fromEntries(Object.entries(secondSnapshot.sources).reverse());
  await writeFile(firstPath, `${JSON.stringify(firstSnapshot, null, 2)}\n`);
  await writeFile(secondPath, `${JSON.stringify(secondSnapshot, null, 2)}\n`);

  const first = await collectWithProvider(fixture.repository, firstPath);
  const second = await collectWithProvider(fixture.repository, secondPath);

  assert.deepEqual(
    first.repositories[0].sources.map((source) => source.system),
    second.repositories[0].sources.map((source) => source.system),
  );
  assert.equal(first.integrity.digest, second.integrity.digest);
});

test("analytics collector binds validation claims to the latest exact repository result", async (context) => {
  const fixture = await githubRepositoryFixture(context);
  const { head } = fixture;
  await writeValidationControl(
    fixture,
    validationResult(head, "github.com/IntelIP/Example", "passed", "exact-pass"),
  );
  const providerPath = join(fixture.root, "provider.json");
  const snapshot = providerSnapshot(head);
  snapshot.deliveryChanges[0].validationStatus = "passed";
  await writeFile(providerPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  const supported = await collectWithProvider(fixture.repository, providerPath);
  const validationSource = supported.repositories[0].sources.find((source) =>
    source.system === "tabellio-validation"
  );
  assert.equal(validationSource.status, "available");
  assert.equal(validationSource.sourceVersion, head);
  assert.equal(supported.repositories[0].deliveryChanges[0].validationStatus, "passed");

  snapshot.deliveryChanges[0].validationStatus = "failed";
  await writeFile(providerPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  const contradicted = await collectWithProvider(fixture.repository, providerPath);
  assert.deepEqual(contradicted.repositories[0].deliveryChanges, []);
  assert.deepEqual(
    providerSources(contradicted).map((source) => source.status),
    ["blocked", "blocked", "blocked", "blocked"],
  );
});

test("analytics collector blocks stale and cross-repository validation controls", async (context) => {
  const cases = [
    {
      name: "stale head",
      record: (head) => validationResult("b".repeat(head.length), "IntelIP/Example", "passed", "stale"),
    },
    {
      name: "cross repository",
      record: (head) => validationResult(head, "IntelIP/Other", "passed", "cross-repository"),
    },
  ];

  for (const value of cases) {
    const fixture = await githubRepositoryFixture(context);
    const { head } = fixture;
    await writeValidationControl(fixture, value.record(head));
    const providerPath = join(fixture.root, `${value.name.replaceAll(" ", "-")}.json`);
    const snapshot = providerSnapshot(head);
    snapshot.deliveryChanges[0].validationStatus = "passed";
    await writeFile(providerPath, `${JSON.stringify(snapshot, null, 2)}\n`);

    const dataset = await collectWithProvider(fixture.repository, providerPath);
    const validationSource = dataset.repositories[0].sources.find((source) =>
      source.system === "tabellio-validation"
    );
    assert.equal(validationSource.status, "blocked", value.name);
    assert.deepEqual(dataset.repositories[0].deliveryChanges, [], value.name);
  }
});

test("analytics collector sanitizes unsafe local repository directory names", async (context) => {
  const fixture = await gitRepositoryFixture(context, "my repo");
  const dataset = await collectFixture(fixture.repository);
  assert.match(dataset.repositories[0].canonicalRepositoryId, /^local\/[0-9a-f]{16}$/);
  assert.doesNotMatch(JSON.stringify(dataset), /my repo/);
});

test("analytics collector converts malformed provider input to blocked evidence", async (context) => {
  const fixture = await gitRepositoryFixture(context);
  const providerPath = join(fixture.root, "provider.json");
  await writeFile(providerPath, "{\"raw\":\"/Users/private/provider.json\"}\n");
  const dataset = await collectAnalyticsDataset({
    id: "INTB-261-p1b",
    observedAt: OBSERVED_AT,
    window: {
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-26T00:00:00.000Z",
    },
    repositories: [{ id: "fixture", path: fixture.repository, providerSnapshot: providerPath }],
  });
  const providerSources = dataset.repositories[0].sources.filter((source) =>
    ["plane", "github", "github-actions", "buildkite"].includes(source.system)
  );
  assert.deepEqual(providerSources.map((source) => source.status), ["blocked", "blocked", "blocked", "blocked"]);
  assert.doesNotMatch(JSON.stringify(dataset), /Users\/private|provider\.json/);
});

test("analytics collector blocks indirect control refs without exporting ref paths", async (context) => {
  const fixture = await gitRepositoryFixture(context);
  await git(fixture.repository, ["tag", "-a", "control-tag", "-m", "control"]);
  const tagOid = await git(fixture.repository, ["rev-parse", "refs/tags/control-tag"]);
  await git(fixture.repository, ["update-ref", "refs/tabellio/validations", tagOid]);
  const source = await collectedValidationSource(fixture.repository);
  assert.equal(source.status, "blocked");
  assert.equal(source.sourceVersion, null);
  assert.equal(source.reason, "Control evidence is malformed or unsafe.");
  assert.doesNotMatch(JSON.stringify(source), /refs\/tabellio|control-tag|Users\//);
});

test("analytics collector blocks unsafe and future-dated control records", async (context) => {
  const fixture = await gitRepositoryFixture(context);
  const head = await git(fixture.repository, ["rev-parse", "HEAD"]);
  const recordPath = join(fixture.repository, "commits", head, "unsafe", "run.json");
  await writeFixture(recordPath, JSON.stringify({
    runId: "unsafe/run",
    completedAt: "2099-01-01T00:00:00.000Z",
    revision: { headCommit: head },
  }));
  const source = await commitBlockedValidationRecord(fixture.repository, "Add unsafe control record");
  assertBlockedControlSource(source);
});

test("analytics collector blocks parseable non-canonical future control timestamps", async (context) => {
  const fixture = await githubRepositoryFixture(context);
  const result = validationResult(
    fixture.head,
    "github.com/IntelIP/Example",
    "passed",
    "future-control",
  );
  result.completedAt = "2099-01-01T00:00:00Z";
  const { integrity: _integrity, ...unsigned } = result;
  result.integrity.digest = digestObject(unsigned);
  await writeValidationControl(fixture, result);
  const source = await collectedValidationSource(fixture.repository);
  assertBlockedControlSource(source);
});

test("analytics collector rejects structurally incomplete control records", async (context) => {
  const fixture = await gitRepositoryFixture(context);
  const head = await git(fixture.repository, ["rev-parse", "HEAD"]);
  const recordPath = join(fixture.repository, "commits", head, "validation-run.json");
  await writeFixture(recordPath, JSON.stringify({
    runId: "validation-run",
    revision: { headCommit: head },
  }));
  const source = await commitBlockedValidationRecord(fixture.repository, "Add incomplete control record");
  assertBlockedControlSource(source);
});

test("analytics CLI rejects config, provider, symlink, and repository output aliases", async (context) => {
  const fixture = await gitRepositoryFixture(context);
  const providerPath = join(fixture.root, "provider.json");
  await writeFile(providerPath, "{}\n");
  const configPath = join(fixture.root, "config.json");
  const config = {
    repositories: [{
      id: "fixture",
      path: fixture.repository,
      providerSnapshot: providerPath,
    }],
  };
  const originalConfig = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(configPath, originalConfig);
  const symlinkPath = join(fixture.root, "provider-alias.json");
  await symlink(providerPath, symlinkPath);
  const hardlinkPath = join(fixture.root, "provider-hardlink.json");
  await link(providerPath, hardlinkPath);
  const common = analyticsCollectArgs(configPath);
  await assertCliFailure([...common, "--out", configPath], /must not alias an input/);
  await assertCliFailure([...common, "--out", providerPath], /must not alias an input/);
  await assertCliFailure([...common, "--out", symlinkPath], /must not be a symbolic link/);
  await assertCliFailure([...common, "--out", hardlinkPath], /must not alias an input/);
  await assertCliFailure([...common, "--out", join(fixture.repository, "analytics.json")], /outside collected repositories/);
  const repositorySubdirectory = join(fixture.repository, "src");
  await mkdir(repositorySubdirectory);
  const subdirectoryConfigPath = join(fixture.root, "subdirectory-config.json");
  await writeFile(subdirectoryConfigPath, `${JSON.stringify({
    repositories: [{
      id: "fixture",
      path: repositorySubdirectory,
      providerSnapshot: "../provider.json",
    }],
  }, null, 2)}\n`);
  await assertCliFailure(
    analyticsCollectArgs(subdirectoryConfigPath, join(fixture.repository, "analytics-from-subdir.json")),
    /outside collected repositories/,
  );
  await assertCliFailure(
    analyticsCollectArgs(subdirectoryConfigPath, providerPath),
    /must not alias an input/,
  );
  assert.equal(await readFile(configPath, "utf8"), originalConfig);

  const missingProviderPath = join(fixture.root, "missing-provider.json");
  const missingConfigPath = join(fixture.root, "missing-config.json");
  await writeFile(missingConfigPath, `${JSON.stringify({
    repositories: [{
      id: "fixture",
      path: fixture.repository,
      providerSnapshot: missingProviderPath,
    }],
  }, null, 2)}\n`);
  await assertCliFailure(
    analyticsCollectArgs(missingConfigPath, missingProviderPath),
    /must not alias an input/,
  );

  const aliasDirectory = join(fixture.root, "aliases");
  await mkdir(aliasDirectory);
  const repositoryAlias = join(aliasDirectory, "repository");
  await symlink(fixture.repository, repositoryAlias);
  const relativeConfigPath = join(fixture.root, "relative-config.json");
  await writeFile(relativeConfigPath, `${JSON.stringify({
    repositories: [{
      id: "fixture",
      path: repositoryAlias,
      providerSnapshot: "../provider.json",
    }],
  }, null, 2)}\n`);
  await assertCliFailure(
    analyticsCollectArgs(relativeConfigPath, providerPath),
    /must not alias an input/,
  );
});

test("analytics CLI collects and rechecks a deterministic dataset", async (context) => {
  const { configPath, outputPath } = await analyticsCliFixture(context, "dataset.json");
  const collect = await runAnalyticsCollect(configPath, outputPath);
  assert.match(collect.stdout, /analytics_dataset_ready/);
  const first = await readFile(outputPath, "utf8");
  const check = await execFileAsync(process.execPath, [
    "scripts/tabellio-analytics.mjs",
    "check",
    "--dataset", outputPath,
  ], { cwd: new URL("..", import.meta.url) });
  assert.match(check.stdout, /analytics_dataset_valid/);
  assert.equal(JSON.stringify(JSON.parse(first)), JSON.stringify(JSON.parse(await readFile(outputPath, "utf8"))));
});

test("analytics CLI creates fresh artifact directory trees", async (context) => {
  const { outputPath, configPath } = await analyticsCliFixture(
    context,
    join("fresh", "artifacts", "dataset.json"),
  );
  const collect = await runAnalyticsCollect(configPath, outputPath);

  assert.match(collect.stdout, /analytics_dataset_ready/);
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).schemaVersion, "tabellio-analytics-dataset/v0.1");
});

test("analytics schema requires source observations and canonical metric states", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schemas/analytics-dataset.v0.1.schema.json", import.meta.url),
    "utf8",
  ));
  assert.ok(schema.$defs.source.required.includes("observedAt"));
  assert.deepEqual(schema.$defs.metric.properties.status.enum, ["measured", "unavailable"]);
  assert.equal(schema.$defs.commit.pattern, "^(?:[0-9a-f]{40}|[0-9a-f]{64})$");
  assertCredentialSafeRepositorySchema(schema.$defs.repositoryIdentifier);
  const portablePatterns = schema.$defs.portableIdentifier.allOf.map((rule) => rule.not.pattern);
  assert.deepEqual(
    portablePatterns.slice(0, 4),
    ["^[fF][iI][lL][eE]:", ":/", "//", "\\.\\."],
  );
  assert.ok(portablePatterns.some((pattern) => new RegExp(pattern).test("ghp_0123456789abcdef")));
  assert.deepEqual(
    schema.properties.metricDefinitions.prefixItems.map((item) => item.const),
    [
      { id: "deliveryChangeCount", unit: "count" },
      { id: "taskToPrTraceability", unit: "ratio" },
      { id: "leadTimeHours", unit: "hours" },
      { id: "cycleTimeHours", unit: "hours" },
      { id: "ciDisagreementRate", unit: "ratio" },
      { id: "releaseLagHours", unit: "hours" },
    ],
  );
  assert.equal(schema.properties.metricDefinitions.items, false);
  const metricState = schema.$defs.metric.allOf[0];
  assert.equal(metricState.then.properties.value.type, "number");
  assert.equal(metricState.then.properties.reason.type, "null");
  assert.equal(metricState.else.properties.value.type, "null");
  assert.equal(metricState.else.properties.reason.$ref, "#/$defs/safeText");
  assert.equal(metricState.else.properties.numerator.type, "null");
  assert.equal(metricState.else.properties.denominator.type, "null");
  const measuredNonRatio = metricState.then.allOf[0].else.properties;
  assert.equal(measuredNonRatio.numerator.type, "null");
  assert.equal(measuredNonRatio.denominator.type, "null");
  assert.equal(schema.$defs.source.allOf[0].then.properties.sourceVersion.$ref, "#/$defs/safeVersion");
  assert.equal(schema.$defs.source.allOf[1].then.properties.sourceVersion.$ref, "#/$defs/commit");
  assert.equal(schema.$defs.deliveryChange.properties.linkEvidence.oneOf[0].$ref, "#/$defs/safeText");
  assert.equal(
    schema.$defs.deliveryChange.allOf[0].then.properties.pullRequestNumber.type,
    "null",
  );
  assert.equal(
    schema.$defs.deliveryChange.allOf[0].else.properties.pullRequestNumber.type,
    "integer",
  );
  for (const unsafe of [
    "token ghp_0123456789abcdef",
    "https://token@github.com/IntelIP/Tabellio",
    "/Users/private/provider.json",
    "safe\u2028unsafe",
    "../private/provider.json",
    "provider error: ./cache.json",
  ]) {
    assert.ok(
      schema.$defs.safeText.allOf.some((rule) => new RegExp(rule.not.pattern).test(unsafe)),
      `schema safeText should reject ${JSON.stringify(unsafe)}`,
    );
  }
  const providerSchema = JSON.parse(await readFile(
    new URL("../schemas/analytics-provider-snapshot.v0.1.schema.json", import.meta.url),
    "utf8",
  ));
  assert.equal(
    providerSchema.properties.schemaVersion.const,
    "tabellio-analytics-provider-snapshot/v0.1",
  );
  assert.ok(providerSchema.required.includes("headCommit"));
  assertCredentialSafeRepositorySchema(providerSchema.$defs.repositoryIdentifier);
  assert.deepEqual(
    providerSchema.properties.sources.required,
    ["plane", "github", "github-actions", "buildkite"],
  );
  const deliverySchema = JSON.parse(await readFile(
    new URL("../schemas/delivery-evidence-snapshot.v0.1.schema.json", import.meta.url),
    "utf8",
  ));
  assertCredentialSafeRepositorySchema(deliverySchema.$defs.repositoryIdentifier);
  assert.ok(deliverySchema.$defs.source.required.includes("observations"));
  assert.equal(deliverySchema.$defs.source.allOf[0].then.properties.observations.minItems, 1);
  assert.equal(
    deliverySchema.$defs.source.allOf[0].else.properties.reason.$ref,
    "#/$defs/safeText",
  );
  assert.equal(
    deliverySchema.$defs.observation.properties.id.$ref,
    "#/$defs/portableIdentifier",
  );
  assert.equal(
    deliverySchema.$defs.record.properties.id.$ref,
    "#/$defs/portableIdentifier",
  );
  for (const unsafe of [
    "ghp_0123456789abcdef",
    "file:///private/evidence.json",
    "FILE:///private/evidence.json",
    "/Users/private/evidence.json",
  ]) {
    assert.ok(
      deliverySchema.$defs.safeText.allOf.some((rule) =>
        new RegExp(rule.not.pattern).test(unsafe)
      ),
      `delivery safeText should reject ${JSON.stringify(unsafe)}`,
    );
  }
  assert.equal(
    deliverySchema.properties.schemaVersion.const,
    "tabellio-delivery-evidence-snapshot/v0.1",
  );
  const packageDefinition = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  assert.equal(packageDefinition.bin["tabellio-analytics"], "scripts/tabellio-analytics.mjs");
});

test("analytics core rejects duplicate repository and source identities", () => {
  const duplicateRepository = createDatasetFixture();
  duplicateRepository.repositories.push(structuredClone(duplicateRepository.repositories[0]));
  assert.throws(() => validateAnalyticsDataset(duplicateRepository), /duplicates repository id.*duplicates canonical repository/s);

  const duplicateSource = createDatasetFixture();
  duplicateSource.repositories[0].sources.push(structuredClone(duplicateSource.repositories[0].sources[0]));
  assert.throws(() => validateAnalyticsDataset(duplicateSource), /duplicates source id.*duplicates source system/s);
});

function createDatasetFixture() {
  return createAnalyticsDataset({
    id: "INTB-261-p1b",
    observedAt: OBSERVED_AT,
    window: {
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-26T00:00:00.000Z",
    },
    repositories: [repositoryFixture()],
  });
}

function repositoryFixture() {
  return {
    id: "tabellio",
    canonicalRepositoryId: "IntelIP/Tabellio",
    headCommit: HEAD,
    headCommittedAt: "2026-07-24T00:00:00.000Z",
    branch: "agent/intb-261-analytics-core",
    sources: [
      source("git", HEAD),
      source("plane", "2026-07-25T00:00:00.000Z"),
      source("github", "2026-07-25T00:00:00.000Z"),
      source("github-actions", "2026-07-25T00:00:00.000Z"),
      source("tabellio-validation", HEAD),
    ],
    metrics: {},
    deliveryChanges: [{
      id: "change-1",
      linkBasis: "explicit",
      linkEvidence: "INTB-261 to PR binding",
      planeStoryId: "INTB-261",
      pullRequestNumber: 35,
      storyCreatedAt: "2026-07-20T00:00:00.000Z",
      firstActivityAt: "2026-07-21T00:00:00.000Z",
      mergedAt: "2026-07-22T00:00:00.000Z",
      releasedAt: "2026-07-23T00:00:00.000Z",
      headCommit: HEAD,
      validationStatus: "passed",
      hostedStatus: "passed",
    }],
  };
}

function source(system, sourceVersion) {
  return {
    id: `${system}-source`,
    system,
    status: "available",
    observedAt: "2026-07-26T00:00:00.000Z",
    sourceVersion,
    contentDigest: "d".repeat(64),
    reason: null,
  };
}

function assertCredentialSafeRepositorySchema(schema) {
  for (const unsafe of [
    "ghp_0123456789abcdef/repository",
    "owner-ghp_0123456789abcdef/repository",
    "github_pat_0123456789abcdef/repository",
    "owner-github_pat_0123456789abcdef/repository",
    "sk-proj_0123456789abcdef/repository",
    "owner-sk-proj_0123456789abcdef/repository",
    "owner-AKIA0123456789ABCDEF/repository",
  ]) {
    assert.ok(
      schema.allOf.some((rule) => new RegExp(rule.not.pattern).test(unsafe)),
      `repository schema should reject ${JSON.stringify(unsafe)}`,
    );
  }
}

function providerSnapshot(headCommit) {
  const sources = Object.fromEntries(
    ["plane", "github", "github-actions", "buildkite"].map((system) => [
      system,
      { status: "available", version: "2026-07-25T00:00:00.000Z" },
    ]),
  );
  return {
    schemaVersion: "tabellio-analytics-provider-snapshot/v0.1",
    repository: "IntelIP/Example",
    headCommit,
    capturedAt: "2026-07-26T00:00:00.000Z",
    sources,
    deliveryChanges: [{
      id: "change-1",
      linkBasis: "explicit",
      linkEvidence: "INTB-261 to PR binding",
      planeStoryId: "INTB-261",
      pullRequestNumber: 35,
      storyCreatedAt: "2026-07-20T00:00:00.000Z",
      firstActivityAt: "2026-07-21T00:00:00.000Z",
      mergedAt: "2026-07-22T00:00:00.000Z",
      headCommit,
      validationStatus: "unavailable",
      hostedStatus: "passed",
    }],
  };
}

function blockPlaneSource(dataset, reason) {
  const source = dataset.repositories[0].sources.find((entry) => entry.system === "plane");
  Object.assign(source, {
    status: "blocked",
    sourceVersion: null,
    contentDigest: null,
    reason,
  });
}

async function collectedValidationSource(repository) {
  const dataset = await collectFixture(repository);
  return dataset.repositories[0].sources.find((entry) => entry.system === "tabellio-validation");
}

async function commitBlockedValidationRecord(repository, message) {
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", message]);
  const controlCommit = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["update-ref", "refs/tabellio/validations", controlCommit]);
  return collectedValidationSource(repository);
}

function assertBlockedControlSource(source) {
  assert.equal(source.status, "blocked");
  assert.equal(source.reason, "Control evidence is malformed or unsafe.");
}

async function gitRepositoryFixture(context, repositoryName = "repository") {
  const root = await mkdtemp(join(tmpdir(), "tabellio-analytics-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, repositoryName);
  await git(root, ["init", "-b", "main", repository]);
  await git(repository, ["config", "user.email", "tabellio@example.test"]);
  await git(repository, ["config", "user.name", "Tabellio Test"]);
  await writeFile(join(repository, "README.md"), "fixture\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "Initial fixture"]);
  return { root, repository };
}

async function githubRepositoryFixture(context) {
  const fixture = await gitRepositoryFixture(context);
  await git(fixture.repository, ["remote", "add", "origin", "git@github.com:IntelIP/Example.git"]);
  return {
    ...fixture,
    head: await git(fixture.repository, ["rev-parse", "HEAD"]),
  };
}

async function analyticsCliFixture(context, outputRelativePath) {
  const fixture = await gitRepositoryFixture(context);
  const configPath = join(fixture.root, "config.json");
  await writeFile(configPath, `${JSON.stringify({
    repositories: [{ id: "fixture", path: fixture.repository }],
  }, null, 2)}\n`);
  return {
    configPath,
    outputPath: join(fixture.root, outputRelativePath),
  };
}

async function collectFixture(repository) {
  return collectAnalyticsDataset({
    id: "INTB-261-p1b",
    observedAt: OBSERVED_AT,
    window: {
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-26T00:00:00.000Z",
    },
    repositories: [{ id: "fixture", path: repository }],
  });
}

async function collectWithProvider(repository, providerSnapshotPath) {
  return collectAnalyticsDataset({
    id: "INTB-261-p1b",
    observedAt: OBSERVED_AT,
    window: {
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-26T00:00:00.000Z",
    },
    repositories: [{ id: "fixture", path: repository, providerSnapshot: providerSnapshotPath }],
  });
}

function providerSources(dataset) {
  return dataset.repositories[0].sources.filter((source) =>
    ["plane", "github", "github-actions", "buildkite"].includes(source.system)
  );
}

function validationResult(headCommit, repositoryId, status, runId) {
  const commandStatus = status === "passed" ? "passed" : "failed";
  const result = {
    schemaVersion: "tabellio-validation-result/v0.1",
    runId,
    repository: { id: repositoryId },
    revision: {
      baseCommit: "a".repeat(headCommit.length),
      mergeBase: "a".repeat(headCommit.length),
      headCommit,
    },
    suite: {
      id: "analytics-test",
      manifestPath: "tabellio.validation.json",
      manifestDigest: "c".repeat(64),
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
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      durationMs: 1,
      stdout: {
        bytes: 0,
        digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        tail: "",
        truncated: false,
      },
      stderr: {
        bytes: 0,
        digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        tail: "",
        truncated: false,
      },
      startedAt: "2026-07-20T00:00:00.000Z",
      completedAt: "2026-07-20T00:01:00.000Z",
      error: null,
    }],
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:01:00.000Z",
  };
  result.integrity = { algorithm: "sha256", digest: digestObject(result) };
  return result;
}

async function writeValidationControl(fixture, result) {
  const valuePath = join(fixture.root, `${result.runId}.json`);
  const indexPath = join(fixture.root, `${result.runId}.index`);
  const recordPath = `commits/${result.revision.headCommit}/${result.runId}.json`;
  await writeFile(valuePath, `${JSON.stringify(result, null, 2)}\n`);
  try {
    const blob = await git(fixture.repository, ["hash-object", "-w", "--", valuePath]);
    const indexEnv = { GIT_INDEX_FILE: indexPath };
    await git(fixture.repository, ["read-tree", "--empty"], indexEnv);
    await git(
      fixture.repository,
      ["update-index", "--add", "--cacheinfo", `100644,${blob},${recordPath}`],
      indexEnv,
    );
    const tree = await git(fixture.repository, ["write-tree"], indexEnv);
    const commit = await git(
      fixture.repository,
      ["commit-tree", tree, "-m", `Record validation ${result.runId}`],
      indexEnv,
    );
    await git(fixture.repository, ["update-ref", "refs/tabellio/validations", commit]);
  } finally {
    await rm(valuePath, { force: true });
    await rm(indexPath, { force: true });
  }
}

async function git(cwd, args, env = {}) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-07-20T00:00:00.000Z",
      GIT_COMMITTER_DATE: "2026-07-20T00:00:00.000Z",
      ...env,
    },
  });
  return stdout.trim();
}

async function writeFixture(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function analyticsCollectArgs(configPath, outputPath = null) {
  const args = [
    "scripts/tabellio-analytics.mjs",
    "collect",
    "--config", configPath,
    "--id", "INTB-261-p1b",
    "--observed-at", OBSERVED_AT,
    "--since", "2026-07-01T00:00:00.000Z",
    "--until", "2026-07-26T00:00:00.000Z",
  ];
  if (outputPath !== null) args.push("--out", outputPath);
  return args;
}

async function runAnalyticsCollect(configPath, outputPath) {
  return execFileAsync(
    process.execPath,
    analyticsCollectArgs(configPath, outputPath),
    { cwd: new URL("..", import.meta.url) },
  );
}

async function assertCliFailure(args, pattern) {
  await assert.rejects(
    execFileAsync(process.execPath, args, {
      cwd: new URL("..", import.meta.url),
    }),
    (error) => {
      assert.match(error.stderr, pattern);
      return true;
    },
  );
}
