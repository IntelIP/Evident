import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  collectAnalyticsDataset,
  createAnalyticsDataset,
  recomputeDeliveryMetrics,
  validateAnalyticsDataset,
} from "../scripts/lib/analytics.mjs";

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
        "2099-01-01T00:00:00.000Z";
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
  ];

  for (const [name, mutate, expected] of cases) {
    const dataset = createDatasetFixture();
    mutate(dataset);
    assert.throws(() => validateAnalyticsDataset(dataset), expected, name);
  }
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
  assert.equal(direct.repositories[0].canonicalRepositoryId, linked.repositories[0].canonicalRepositoryId);
  assert.equal(direct.repositories[0].canonicalRepositoryId, `local/${basename(fixture.repository)}`);
});

test("analytics collector accepts a bound sanitized provider snapshot", async (context) => {
  const fixture = await gitRepositoryFixture(context);
  await git(fixture.repository, ["remote", "add", "origin", "git@github.com:IntelIP/Example.git"]);
  const head = await git(fixture.repository, ["rev-parse", "HEAD"]);
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
  await git(fixture.repository, ["add", "."]);
  await git(fixture.repository, ["commit", "-m", "Add unsafe control record"]);
  const controlCommit = await git(fixture.repository, ["rev-parse", "HEAD"]);
  await git(fixture.repository, ["update-ref", "refs/tabellio/validations", controlCommit]);
  const source = await collectedValidationSource(fixture.repository);
  assert.equal(source.status, "blocked");
  assert.equal(source.reason, "Control evidence is malformed or unsafe.");
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
  const common = [
    "scripts/tabellio-analytics.mjs",
    "collect",
    "--config", configPath,
    "--id", "INTB-261-p1b",
    "--observed-at", OBSERVED_AT,
    "--since", "2026-07-01T00:00:00.000Z",
    "--until", "2026-07-26T00:00:00.000Z",
  ];
  await assertCliFailure([...common, "--out", configPath], /must not alias an input/);
  await assertCliFailure([...common, "--out", providerPath], /must not alias an input/);
  await assertCliFailure([...common, "--out", symlinkPath], /must not be a symbolic link/);
  await assertCliFailure([...common, "--out", hardlinkPath], /must not alias an input/);
  await assertCliFailure([...common, "--out", join(fixture.repository, "analytics.json")], /outside collected repositories/);
  assert.equal(await readFile(configPath, "utf8"), originalConfig);
});

test("analytics CLI collects and rechecks a deterministic dataset", async (context) => {
  const fixture = await gitRepositoryFixture(context);
  const configPath = join(fixture.root, "config.json");
  const outputPath = join(fixture.root, "dataset.json");
  await writeFile(configPath, `${JSON.stringify({
    repositories: [{ id: "fixture", path: fixture.repository }],
  }, null, 2)}\n`);
  const collect = await execFileAsync(process.execPath, [
    "scripts/tabellio-analytics.mjs",
    "collect",
    "--config", configPath,
    "--id", "INTB-261-p1b",
    "--observed-at", OBSERVED_AT,
    "--since", "2026-07-01T00:00:00.000Z",
    "--until", "2026-07-26T00:00:00.000Z",
    "--out", outputPath,
  ], { cwd: new URL("..", import.meta.url) });
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

test("analytics schema requires source observations and canonical metric states", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schemas/analytics-dataset.v0.1.schema.json", import.meta.url),
    "utf8",
  ));
  assert.ok(schema.$defs.source.required.includes("observedAt"));
  assert.deepEqual(schema.$defs.metric.properties.status.enum, ["measured", "unavailable"]);
  assert.equal(schema.$defs.commit.pattern, "^(?:[0-9a-f]{40}|[0-9a-f]{64})$");
  const deliverySchema = JSON.parse(await readFile(
    new URL("../schemas/delivery-evidence-snapshot.v0.1.schema.json", import.meta.url),
    "utf8",
  ));
  assert.ok(deliverySchema.$defs.source.required.includes("observations"));
  assert.equal(deliverySchema.$defs.source.allOf[0].then.properties.observations.minItems, 1);
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

async function gitRepositoryFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "tabellio-analytics-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  await git(root, ["init", "-b", "main", repository]);
  await git(repository, ["config", "user.email", "tabellio@example.test"]);
  await git(repository, ["config", "user.name", "Tabellio Test"]);
  await writeFile(join(repository, "README.md"), "fixture\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "Initial fixture"]);
  return { root, repository };
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

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-07-20T00:00:00.000Z",
      GIT_COMMITTER_DATE: "2026-07-20T00:00:00.000Z",
    },
  });
  return stdout.trim();
}

async function writeFixture(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
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
