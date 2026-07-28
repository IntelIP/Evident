import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalJson } from "./context-packet.mjs";
import { parseGitHubRepositoryRemote } from "./github-repository.mjs";
import { runGit } from "./git-process.mjs";
import {
  canonicalRepositoryId,
  isPortableIdentifier,
  isSafeProviderText,
  isSafeProviderVersion,
  validateProviderSnapshot,
} from "./portable-evidence.mjs";
import { localRepositoryId } from "./repository-identity.mjs";
import { validateReviewCycle } from "./review-cycle.mjs";
import { validateValidationResult } from "./validation-runner.mjs";

const SCHEMA_VERSION = "tabellio-analytics-dataset/v0.1";
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_STATES = new Set(["available", "unavailable", "blocked"]);
const GIT_BACKED_SYSTEMS = new Set(["git", "tabellio-validation", "tabellio-review", "entire"]);
const PROVIDER_SYSTEMS = new Set(["plane", "github", "github-actions", "buildkite"]);
const CONTROL_SOURCES = Object.freeze([
  Object.freeze({
    id: "tabellio-validation",
    ref: "refs/tabellio/validations",
    validateRecord: validateValidationControlRecord,
  }),
  Object.freeze({
    id: "tabellio-review",
    ref: "refs/tabellio/reviews",
    validateRecord: validateReviewControlRecord,
  }),
  Object.freeze({
    id: "entire",
    ref: "refs/heads/entire/checkpoints/v1",
    validateRecord: null,
  }),
]);

const DELIVERY_METRIC_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "deliveryChangeCount", unit: "count" }),
  Object.freeze({ id: "taskToPrTraceability", unit: "ratio" }),
  Object.freeze({ id: "leadTimeHours", unit: "hours" }),
  Object.freeze({ id: "cycleTimeHours", unit: "hours" }),
  Object.freeze({ id: "ciDisagreementRate", unit: "ratio" }),
  Object.freeze({ id: "releaseLagHours", unit: "hours" }),
]);

export async function collectAnalyticsDataset({ id, observedAt, window, repositories }) {
  if (!requiredArray(repositories)) throw new Error("Analytics collection requires repositories.");
  const collected = await Promise.all(repositories.map((repository) =>
    collectRepository(repository, observedAt)
  ));
  return createAnalyticsDataset({ id, observedAt, window, repositories: collected });
}

export function createAnalyticsDataset({ id, observedAt, window, repositories }) {
  const dataset = {
    schemaVersion: SCHEMA_VERSION,
    id,
    observedAt,
    window: structuredClone(window),
    metricDefinitions: structuredClone(DELIVERY_METRIC_DEFINITIONS),
    repositories: repositories.map((repository) => prepareRepository(repository, window)),
  };
  dataset.integrity = {
    algorithm: "sha256",
    digest: digestDataset(dataset),
  };
  validateAnalyticsDataset(dataset);
  return dataset;
}

export function validateAnalyticsDataset(dataset) {
  if (!isPlainObject(dataset)) throw new Error("Analytics dataset must be an object.");
  const errors = [];
  rejectUnknownFields(
    dataset,
    ["schemaVersion", "id", "observedAt", "window", "metricDefinitions", "repositories", "integrity"],
    "dataset",
    errors,
  );
  errors.push(...ruleErrors([
    [dataset.schemaVersion === SCHEMA_VERSION, "Dataset schemaVersion is invalid."],
    [isPortableIdentifier(dataset.id), "Dataset id is not portable."],
    [isDateTime(dataset.observedAt), "Dataset observedAt is invalid."],
    [validWindow(dataset.window, dataset.observedAt), "Dataset observation window is invalid."],
    [
      canonicalJson(dataset.metricDefinitions) === canonicalJson(DELIVERY_METRIC_DEFINITIONS),
      "Dataset metric definitions are not canonical.",
    ],
  ]));
  errors.push(...validateRepositories(dataset.repositories, dataset.observedAt, dataset.window));
  errors.push(...validateIntegrity(dataset));
  if (errors.length > 0) throw new Error(unique(errors).join("\n"));
  return dataset;
}

export function recomputeDeliveryMetrics(repository, window = null) {
  const changes = deliveryChangesWithinWindow(repository?.deliveryChanges, window);
  const linked = changes.filter(isLinkedChange);
  return {
    deliveryChangeCount: deliveryChangeCount(repository, changes),
    taskToPrTraceability: traceabilityMetric(repository, changes, linked),
    leadTimeHours: durationMetric(repository, linked, "storyCreatedAt", "mergedAt", ["plane", "github"]),
    cycleTimeHours: durationMetric(repository, linked, "firstActivityAt", "mergedAt", ["plane", "github"]),
    ciDisagreementRate: disagreementMetric(repository, changes),
    releaseLagHours: durationMetric(repository, changes, "mergedAt", "releasedAt", ["github"]),
  };
}

function prepareRepository(repository, window) {
  const prepared = structuredClone(repository);
  if (Array.isArray(prepared.deliveryChanges)) {
    prepared.deliveryChanges = deliveryChangesWithinWindow(prepared.deliveryChanges, window);
  }
  prepared.metrics = recomputeDeliveryMetrics(prepared, window);
  return prepared;
}

function deliveryChangesWithinWindow(changes, window) {
  if (!Array.isArray(changes)) return [];
  if (!hasDeliveryWindowBounds(window)) return changes;
  return changes.filter((change) => deliveryChangeWithinWindow(change, window));
}

function hasDeliveryWindowBounds(window) {
  return isPlainObject(window) && isDateTime(window.since) && isDateTime(window.until);
}

function deliveryChangeWithinWindow(change, window) {
  const timestamp = deliveryChangeWindowTimestamp(change);
  return isDateTime(timestamp)
    && Date.parse(window.since) <= Date.parse(timestamp)
    && Date.parse(timestamp) <= Date.parse(window.until);
}

function deliveryChangeWindowTimestamp(change) {
  if (!isPlainObject(change)) return null;
  return change.mergedAt ?? change.firstActivityAt ?? change.storyCreatedAt;
}

async function collectRepository(input, observedAt) {
  validateRepositoryInput(input);
  const repositoryPath = await realpath(input.path);
  const [headCommit, headCommittedAt, branch, remote] = await Promise.all([
    gitText(repositoryPath, ["rev-parse", "HEAD"]),
    gitText(repositoryPath, ["show", "-s", "--format=%cI", "HEAD"]),
    gitText(repositoryPath, ["branch", "--show-current"]),
    optionalGitText(repositoryPath, ["remote", "get-url", "origin"]),
  ]);
  const canonicalId = repositoryIdentityFromRemote(remote, repositoryPath);
  const gitSource = availableSource({
    id: `${input.id}:git`,
    system: "git",
    observedAt,
    sourceVersion: headCommit,
    content: { headCommit, headCommittedAt, branch },
  });
  const controlEvidence = await Promise.all(CONTROL_SOURCES.map((control) =>
    collectControlSource(repositoryPath, input.id, observedAt, control, {
      canonicalRepositoryId: canonicalId,
      headCommit,
    })
  ));
  const controls = controlEvidence.map((evidence) => evidence.source);
  const validationResult = controlEvidence.find((evidence) =>
    evidence.system === "tabellio-validation"
  )?.validationResult ?? null;
  const provider = await collectProviderEvidence({
    input,
    repositoryPath,
    canonicalRepositoryId: canonicalId,
    headCommit,
    observedAt,
    validationResult,
  });
  await assertRepositorySnapshotStable(repositoryPath, { headCommit, branch, remote });
  return {
    id: input.id,
    canonicalRepositoryId: canonicalId,
    headCommit,
    headCommittedAt: normalizeDateTime(headCommittedAt),
    branch: portableBranch(branch || "detached"),
    sources: [gitSource, ...controls, ...provider.sources],
    metrics: {},
    deliveryChanges: provider.deliveryChanges,
  };
}

function portableBranch(branch) {
  return isPortableIdentifier(branch)
    ? branch
    : `branch/${createHash("sha256").update(branch).digest("hex").slice(0, 16)}`;
}

async function assertRepositorySnapshotStable(repositoryPath, expected) {
  const [headCommit, branch, remote] = await Promise.all([
    gitText(repositoryPath, ["rev-parse", "HEAD"]),
    gitText(repositoryPath, ["branch", "--show-current"]),
    optionalGitText(repositoryPath, ["remote", "get-url", "origin"]),
  ]);
  if (canonicalJson({ headCommit, branch, remote }) !== canonicalJson(expected)) {
    throw new Error("Repository revision or identity changed during analytics collection.");
  }
}

function validateRepositoryInput(input) {
  if (!isPlainObject(input)) throw new Error("Repository input must be an object.");
  if (!isPortableIdentifier(input.id)) throw new Error("Repository input id is not portable.");
  if (typeof input.path !== "string") throw new Error("Repository input path is required.");
}

async function collectControlSource(repositoryPath, repositoryId, observedAt, control, candidate) {
  const exists = await runGit({
    cwd: repositoryPath,
    args: ["show-ref", "--verify", "--quiet", control.ref],
    acceptableExitCodes: [0, 1],
  });
  if (exists.exitCode !== 0) {
    return {
      system: control.id,
      source: unavailableSource({
        id: `${repositoryId}:${control.id}`,
        system: control.id,
        observedAt,
        reason: "Control evidence is unavailable.",
      }),
      validationResult: null,
    };
  }
  try {
    return await collectExistingControlSource(
      repositoryPath,
      repositoryId,
      observedAt,
      control,
      candidate,
    );
  } catch {
    return {
      system: control.id,
      source: blockedSource({
        id: `${repositoryId}:${control.id}`,
        system: control.id,
        observedAt,
        reason: "Control evidence is malformed or unsafe.",
      }),
      validationResult: null,
    };
  }
}

async function collectExistingControlSource(
  repositoryPath,
  repositoryId,
  observedAt,
  control,
  candidate,
) {
  const version = await gitText(repositoryPath, ["rev-parse", "--verify", control.ref]);
  const objectType = await gitText(repositoryPath, ["cat-file", "-t", control.ref]);
  if (objectType !== "commit") throw new Error("Control ref is not a direct commit.");
  const committedAt = await gitText(repositoryPath, ["show", "-s", "--format=%cI", version]);
  if (!isAtOrBefore(normalizeDateTime(committedAt), observedAt)) {
    throw new Error("Control ref is newer than observation.");
  }
  const records = await controlRecords(repositoryPath, version, control, observedAt);
  const selected = selectControlEvidence(control, records, candidate, version);
  return {
    system: control.id,
    source: availableSource({
      id: `${repositoryId}:${control.id}`,
      system: control.id,
      observedAt,
      sourceVersion: selected.sourceVersion,
      content: { records: selected.records, version },
    }),
    validationResult: selected.validationResult,
  };
}

function controlRecords(repositoryPath, version, control, observedAt) {
  if (control.validateRecord === null) return [];
  return readControlRecords(repositoryPath, version, control.validateRecord, observedAt);
}

function selectControlEvidence(control, records, candidate, version) {
  if (control.id !== "tabellio-validation") {
    return { records, sourceVersion: version, validationResult: null };
  }
  const validationResult = latestCandidateValidationResult(records, candidate);
  if (validationResult === null) {
    throw new Error("Validation control evidence does not bind the repository head.");
  }
  return {
    records: [validationResult],
    sourceVersion: candidate.headCommit,
    validationResult,
  };
}

function latestCandidateValidationResult(records, { canonicalRepositoryId: repository, headCommit }) {
  const expectedRepository = normalizedAnalyticsRepositoryId(repository);
  return records
    .filter((record) =>
      normalizedAnalyticsRepositoryId(record?.repository?.id) === expectedRepository
      && validationHeadCommit(record) === headCommit
    )
    .sort((left, right) =>
      Date.parse(right.completedAt) - Date.parse(left.completedAt)
      || right.runId.localeCompare(left.runId)
    )[0] ?? null;
}

function normalizedAnalyticsRepositoryId(value) {
  const direct = canonicalRepositoryId(value);
  if (direct !== null) return direct;
  const github = parseGitHubRepositoryRemote(`https://${value}`);
  return canonicalRepositoryId(github?.fullName);
}

async function readControlRecords(repositoryPath, version, validateRecord, observedAt) {
  const output = await gitText(repositoryPath, ["ls-tree", "-r", "-z", "--name-only", version]);
  const names = output.split("\0").filter((name) => name.endsWith(".json")).sort();
  const records = [];
  for (const name of names) {
    const raw = await gitText(repositoryPath, ["show", `${version}:${name}`]);
    const record = JSON.parse(raw);
    validateRecord(record, name, observedAt);
    records.push(record);
  }
  return records;
}

function validateValidationControlRecord(record, name, observedAt) {
  validateValidationResult(record);
  validateGenericControlRecord(record, name, observedAt);
  const headCommit = validationHeadCommit(record);
  assertRules([
    [headCommit !== null, "Validation revision is missing."],
    [matches(COMMIT_PATTERN, headCommit), "Validation head is invalid."],
    [safeControlSegment(record.runId), "Validation run id is unsafe."],
    [name === validationControlPath(headCommit, record.runId), "Validation control path is invalid."],
  ]);
}

function validateReviewControlRecord(record, name, observedAt) {
  validateReviewCycle(record);
  validateGenericControlRecord(record, name, observedAt);
}

function validateGenericControlRecord(record, _name, observedAt) {
  if (!isPlainObject(record)) throw new Error("Control record must be an object.");
  if (containsFutureTimestamp(record, observedAt)) throw new Error("Control record is newer than observation.");
}

function containsFutureTimestamp(value, observedAt) {
  return Object.entries(value).some(([key, field]) =>
    fieldIsFutureTimestamp(key, field, observedAt)
      || nestedFieldIsFuture(field, observedAt)
  );
}

function fieldIsFutureTimestamp(key, value, observedAt) {
  return key.endsWith("At")
    && isDateTime(value)
    && Date.parse(value) > Date.parse(observedAt);
}

function nestedFieldIsFuture(value, observedAt) {
  if (Array.isArray(value)) return value.some((entry) => nestedFieldIsFuture(entry, observedAt));
  return isPlainObject(value) && containsFutureTimestamp(value, observedAt);
}

function safeControlSegment(value) {
  return isPortableIdentifier(value) && !value.includes("/");
}

function validationHeadCommit(record) {
  return isPlainObject(record.revision) ? record.revision.headCommit : null;
}

function validationControlPath(headCommit, runId) {
  return `commits/${headCommit}/${runId}.json`;
}

async function collectProviderEvidence({
  input,
  repositoryPath,
  canonicalRepositoryId,
  headCommit,
  observedAt,
  validationResult,
}) {
  if (input.providerSnapshot === undefined) {
    return missingProviderEvidence(input.id, observedAt);
  }
  try {
    return await collectProviderSnapshot({
      input,
      repositoryPath,
      canonicalRepositoryId,
      headCommit,
      observedAt,
      validationResult,
    });
  } catch {
    return blockedProviderEvidence(input.id, observedAt);
  }
}

async function collectProviderSnapshot({
  input,
  repositoryPath,
  canonicalRepositoryId,
  headCommit,
  observedAt,
  validationResult,
}) {
  const snapshotPath = await realpath(resolveInputPath(repositoryPath, input.providerSnapshot));
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const errors = validateProviderSnapshot(snapshot, {
    repository: canonicalRepositoryId,
    headCommit,
    observedAt,
  });
  if (errors.length > 0) throw new Error("Provider snapshot is invalid.");
  if (!validationClaimsSupported(snapshot.deliveryChanges, validationResult)) {
    throw new Error("Provider validation claims do not match exact-head validation evidence.");
  }
  return {
    sources: [...PROVIDER_SYSTEMS].map((system) =>
      providerSource(input.id, system, snapshot.sources[system], snapshot.capturedAt)
    ),
    deliveryChanges: snapshot.deliveryChanges.map(normalizeDeliveryChange),
  };
}

function validationClaimsSupported(deliveryChanges, validationResult) {
  return deliveryChanges.every((change) =>
    change.validationStatus === "unavailable"
    || change.validationStatus === validationResult?.status
  );
}

function resolveInputPath(repositoryPath, value) {
  return resolve(repositoryPath, value);
}

function missingProviderEvidence(repositoryId, observedAt) {
  return {
    sources: [...PROVIDER_SYSTEMS].map((system) => unavailableSource({
      id: `${repositoryId}:${system}`,
      system,
      observedAt,
      reason: "Provider evidence is unavailable.",
    })),
    deliveryChanges: [],
  };
}

function blockedProviderEvidence(repositoryId, observedAt) {
  return {
    sources: [...PROVIDER_SYSTEMS].map((system) => blockedSource({
      id: `${repositoryId}:${system}`,
      system,
      observedAt,
      reason: "Provider evidence is malformed or unsafe.",
    })),
    deliveryChanges: [],
  };
}

function providerSource(repositoryId, system, source, observedAt) {
  if (source.status === "available") {
    return availableSource({
        id: `${repositoryId}:${system}`,
        system,
        observedAt,
        sourceVersion: source.version,
        content: source,
      });
  }
  const sourceFactory = source.status === "blocked" ? blockedSource : unavailableSource;
  return sourceFactory({
    id: `${repositoryId}:${system}`,
    system,
    observedAt,
    reason: source.reason,
  });
}

function normalizeDeliveryChange(change) {
  return {
    ...structuredClone(change),
    releasedAt: null,
  };
}

function repositoryIdentityFromRemote(remote, repositoryPath) {
  const github = portableGitHubRemote(remote);
  return github?.fullName ?? localRepositoryId(repositoryPath);
}

function portableGitHubRemote(remote) {
  const direct = parseGitHubRepositoryRemote(remote);
  if (direct) return direct;
  return credentialedGitHubRemote(remote);
}

function credentialedGitHubRemote(remote) {
  try {
    const url = new URL(remote);
    if (!isGitHubHttps(url)) return null;
    url.username = "";
    url.password = "";
    return parseGitHubRepositoryRemote(url.href);
  } catch {
    return null;
  }
}

function isGitHubHttps(url) {
  return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com";
}

async function gitText(cwd, args) {
  const result = await runGit({ cwd, args });
  return result.stdout.trim();
}

async function optionalGitText(cwd, args) {
  const result = await runGit({ cwd, args, acceptableExitCodes: [0, 2] });
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

function availableSource({ id, system, observedAt, sourceVersion, content }) {
  return {
    id,
    system,
    status: "available",
    observedAt,
    sourceVersion,
    contentDigest: createHash("sha256").update(canonicalJson(content)).digest("hex"),
    reason: null,
  };
}

function unavailableSource({ id, system, observedAt, reason }) {
  return {
    id,
    system,
    status: "unavailable",
    observedAt,
    sourceVersion: null,
    contentDigest: null,
    reason,
  };
}

function blockedSource({ id, system, observedAt, reason }) {
  return {
    ...unavailableSource({ id, system, observedAt, reason }),
    status: "blocked",
  };
}

function validateRepository(repository, observedAt, window) {
  if (!isPlainObject(repository)) return ["must be an object."];
  const errors = [];
  rejectUnknownFields(
    repository,
    ["id", "canonicalRepositoryId", "headCommit", "headCommittedAt", "branch", "sources", "metrics", "deliveryChanges"],
    "repository",
    errors,
  );
  errors.push(...ruleErrors([
    [isPortableIdentifier(repository.id), "id is not portable."],
    [canonicalRepositoryId(repository.canonicalRepositoryId) !== null, "canonicalRepositoryId is invalid."],
  ]));
  errors.push(...validateSources(repository.sources, observedAt));
  errors.push(...validateRevision(repository, observedAt));
  errors.push(...validateGitSourceFormatBinding(repository));
  errors.push(...validateValidationSourceBinding(repository));
  errors.push(...validateDeliveryChanges(
    repository.deliveryChanges,
    observedAt,
    repository.headCommit,
    window,
  ));
  errors.push(...validateDeliverySourceConsistency(repository));
  errors.push(...validateMetrics(repository, window));
  return errors;
}

function validateValidationSourceBinding(repository) {
  const validationSource = repositorySources(repository).find((source) =>
    source?.system === "tabellio-validation"
  );
  if (validationSource?.status !== "available") return [];
  return ruleErrors([
    [
      validationSource.sourceVersion === repository.headCommit,
      "Validation source version does not match headCommit.",
    ],
  ]);
}

function validateGitSourceFormatBinding(repository) {
  if (!matches(COMMIT_PATTERN, repository.headCommit)) return [];
  return repositorySources(repository).flatMap((source, index) =>
    gitSourceFormatMismatch(source, repository.headCommit)
      ? [`sources[${index}]: Git-backed source object format does not match headCommit.`]
      : []
  );
}

function gitSourceFormatMismatch(source, headCommit) {
  if (!isAvailableGitBackedSource(source)) return false;
  if (!matches(COMMIT_PATTERN, source.sourceVersion)) return false;
  return source.sourceVersion.length !== headCommit.length;
}

function isAvailableGitBackedSource(source) {
  return source?.status === "available" && GIT_BACKED_SYSTEMS.has(source.system);
}

function validateSource(source, observedAt) {
  if (!isPlainObject(source)) return ["must be an object."];
  const errors = [];
  rejectUnknownFields(
    source,
    ["id", "system", "status", "observedAt", "sourceVersion", "contentDigest", "reason"],
    "source",
    errors,
  );
  errors.push(...ruleErrors([
    [isPortableIdentifier(source.id), "id is not portable."],
    [isPortableIdentifier(source.system), "system is not portable."],
    [SOURCE_STATES.has(source.status), "status is invalid."],
    [isAtOrBefore(source.observedAt, observedAt), "observedAt is invalid or later than the dataset."],
    [versionNotAfterObservation(source), "provider source version is later than its observation."],
  ]));
  errors.push(...validateSourcePayload(source));
  return errors;
}

function validateRevision(repository, observedAt) {
  const gitSource = repositorySources(repository).find((source) => source?.system === "git");
  return gitSource?.status === "available"
    ? validateAvailableRevision(repository, observedAt, gitSource)
    : validateUnavailableRevision(repository);
}

function validateAvailableRevision(repository, observedAt, gitSource) {
  return ruleErrors([
    [matches(COMMIT_PATTERN, repository.headCommit), "headCommit is invalid."],
    [repository.headCommit === gitSource.sourceVersion, "Git source version does not match headCommit."],
    [
      isAtOrBefore(repository.headCommittedAt, observedAt),
      "headCommittedAt is invalid or later than observation.",
    ],
    [isPortableIdentifier(repository.branch), "branch is not portable."],
  ]);
}

function validateUnavailableRevision(repository) {
  return ruleErrors([
    [
      allNull([repository.headCommit, repository.headCommittedAt, repository.branch]),
      "Unavailable Git evidence requires a null revision.",
    ],
  ]);
}

function validateDeliveryChange(change, observedAt, headCommit) {
  if (!isPlainObject(change)) return ["must be an object."];
  const errors = [];
  const fields = [
    "id", "linkBasis", "linkEvidence", "planeStoryId", "pullRequestNumber",
    "storyCreatedAt", "firstActivityAt", "mergedAt", "releasedAt", "headCommit",
    "validationStatus", "hostedStatus",
  ];
  rejectUnknownFields(change, fields, "delivery change", errors);
  errors.push(...validateDeliveryIdentity(change));
  errors.push(...ruleErrors([
    [change.headCommit === headCommit, "headCommit does not match the repository head."],
  ]));
  errors.push(...validateDeliveryRelationship(change));
  errors.push(...validateDeliveryTimes(change, observedAt));
  return errors;
}

function validateDeliveryIdentity(change) {
  const resultStates = ["passed", "failed", "blocked", "unavailable"];
  return ruleErrors([
    [isPortableIdentifier(change.id), "id is not portable."],
    [["explicit", "manual-reconciliation", "unlinked"].includes(change.linkBasis), "linkBasis is invalid."],
    [nullableSafeText(change.linkEvidence), "linkEvidence is unsafe."],
    [matches(COMMIT_PATTERN, change.headCommit), "headCommit is invalid."],
    [resultStates.includes(change.validationStatus), "validationStatus is invalid."],
    [resultStates.includes(change.hostedStatus), "hostedStatus is invalid."],
  ]);
}

function validateDeliveryRelationship(change) {
  const linked = change.linkBasis !== "unlinked";
  return ruleErrors([
    [
      linked ? validLinkedRelationship(change) : true,
      "linked change requires Plane and pull-request identifiers.",
    ],
    [
      linked ? true : validUnlinkedRelationship(change),
      "unlinked change requires null relationship fields.",
    ],
  ]);
}

function validateDeliveryTimes(change, observedAt) {
  const times = ["storyCreatedAt", "firstActivityAt", "mergedAt", "releasedAt"];
  const errors = times.flatMap((field) =>
    optionalDateAtOrBefore(change[field], observedAt)
      ? []
      : [`${field} is invalid or later than observation.`]
  );
  const ordered = times.map((field) => [field, change[field]]).filter(([, value]) => isDateTime(value));
  errors.push(...ordered.slice(1).flatMap((current, index) =>
    Date.parse(ordered[index][1]) <= Date.parse(current[1])
      ? []
      : [`${ordered[index][0]} is later than ${current[0]}.`]
  ));
  return errors;
}

function validateRepositories(repositories, observedAt, window) {
  if (!requiredArray(repositories)) return ["Dataset requires at least one repository."];
  const errors = repositories.flatMap((repository, index) =>
    prefix(`repositories[${index}]`, validateRepository(repository, observedAt, window))
  );
  errors.push(...duplicateValueErrors(
    repositories,
    (repository) => repository?.id,
    isPortableIdentifier,
    (index) => `repositories[${index}] duplicates repository id.`,
  ));
  errors.push(...duplicateValueErrors(
    repositories,
    (repository) => canonicalRepositoryId(repository?.canonicalRepositoryId),
    isNonNull,
    (index) => `repositories[${index}] duplicates canonical repository.`,
  ));
  return errors;
}

function validateIntegrity(dataset) {
  if (!isPlainObject(dataset.integrity)) return ["Dataset integrity is invalid."];
  const errors = [];
  rejectUnknownFields(dataset.integrity, ["algorithm", "digest"], "integrity", errors);
  const structureErrors = ruleErrors([
    [dataset.integrity.algorithm === "sha256", "algorithm"],
    [matches(SHA256_PATTERN, dataset.integrity.digest), "digest"],
  ]);
  if (structureErrors.length > 0) errors.push("Dataset integrity is invalid.");
  if (structureErrors.length > 0) return errors;
  errors.push(...ruleErrors([
    [dataset.integrity.digest === digestDataset(dataset), "Dataset integrity digest does not match."],
  ]));
  return errors;
}

function validateAvailableSource(source) {
  return ruleErrors([
    [matches(SHA256_PATTERN, source.contentDigest), "available source requires a content digest."],
    [source.reason === null, "available source cannot have a reason."],
    [validGitSourceVersion(source), "Git-backed source version must be a commit object id."],
    [validProviderSourceVersion(source), "provider source version is unsafe."],
  ]);
}

function validateUnavailableSource(source) {
  return ruleErrors([
    [isSafeProviderText(source.reason), "unavailable source requires a safe reason."],
    [
      allNull([source.sourceVersion, source.contentDigest]),
      "unavailable source cannot carry version or digest evidence.",
    ],
  ]);
}

function validateSources(sources, observedAt) {
  if (!requiredArray(sources)) return ["sources are required."];
  const errors = sources.flatMap((source, index) =>
    prefix(`sources[${index}]`, validateSource(source, observedAt))
  );
  errors.push(...duplicateValueErrors(
    sources,
    (source) => source?.id,
    isPortableIdentifier,
    (index) => `sources[${index}] duplicates source id.`,
  ));
  errors.push(...duplicateValueErrors(
    sources,
    (source) => source?.system,
    isString,
    (index) => `sources[${index}] duplicates source system.`,
  ));
  return errors;
}

function validateDeliveryChanges(changes, observedAt, headCommit, window) {
  if (!Array.isArray(changes)) return ["deliveryChanges must be an array."];
  const errors = changes.flatMap((change, index) =>
    prefix(`deliveryChanges[${index}]`, [
      ...validateDeliveryChange(change, observedAt, headCommit),
      ...validateDeliveryWindow(change, window),
    ])
  );
  errors.push(...duplicateValueErrors(
    changes,
    (change) => change?.id,
    isPortableIdentifier,
    (index) => `deliveryChanges[${index}] duplicates change id.`,
  ));
  errors.push(...duplicateValueErrors(
    changes,
    deliveryRelationshipKey,
    isNonNull,
    (index) => `deliveryChanges[${index}] duplicates Plane and pull-request relationship.`,
  ));
  return errors;
}

function validateDeliveryWindow(change, window) {
  if (!hasDeliveryWindowBounds(window)) return [];
  return ruleErrors([
    [deliveryChangeWithinWindow(change, window), "is outside the dataset observation window."],
  ]);
}

function deliveryRelationshipKey(change) {
  return isLinkedChange(change)
    ? canonicalJson([change.planeStoryId, change.pullRequestNumber])
    : null;
}

function validateMetrics(repository, window) {
  const expected = recomputeDeliveryMetrics(repository, window);
  return ruleErrors([
    [
      canonicalJson(repository.metrics) === canonicalJson(expected),
      "metrics contradict validated delivery changes or source availability.",
    ],
  ]);
}

function validateDeliverySourceConsistency(repository) {
  if (!Array.isArray(repository.deliveryChanges)) return [];
  return repository.deliveryChanges.flatMap((change, index) =>
    prefix(`deliveryChanges[${index}]`, deliverySourceErrors(repository, change))
  );
}

function deliverySourceErrors(repository, change) {
  if (!isPlainObject(change)) return [];
  return ruleErrors([
    [
      linkedSourcesAvailable(repository, change),
      "linked change requires available Plane and GitHub evidence.",
    ],
    [
      planeTimestampSupported(repository, change),
      "storyCreatedAt requires available Plane evidence.",
    ],
    [
      githubLifecycleSupported(repository, change),
      "GitHub lifecycle timestamps require available GitHub evidence.",
    ],
    [
      validationStatusSupported(repository, change),
      "validationStatus requires available exact validation evidence.",
    ],
    [
      hostedStatusSupported(repository, change),
      "hostedStatus requires available hosted evidence.",
    ],
  ]);
}

function linkedSourcesAvailable(repository, change) {
  return change.linkBasis === "unlinked" || available(repository, ["plane", "github"]);
}

function planeTimestampSupported(repository, change) {
  return change.storyCreatedAt === null || available(repository, ["plane"]);
}

function githubLifecycleSupported(repository, change) {
  return !hasGitHubLifecycle(change) || available(repository, ["github"]);
}

function validationStatusSupported(repository, change) {
  return change.validationStatus === "unavailable"
    || available(repository, ["tabellio-validation"]);
}

function hostedStatusSupported(repository, change) {
  return change.hostedStatus === "unavailable"
    || availableAny(repository, ["github-actions", "buildkite"]);
}

function hasGitHubLifecycle(change) {
  return change.firstActivityAt !== null || change.mergedAt !== null || change.releasedAt !== null;
}

function durationMetric(repository, changes, startField, endField, systems) {
  if (!available(repository, systems)) return unavailable("hours", `${systems.join(" and ")} evidence unavailable.`);
  const values = changes
    .filter((change) => validDurationPair(change, startField, endField))
    .map((change) => (Date.parse(change[endField]) - Date.parse(change[startField])) / 3_600_000);
  if (values.length === 0) return unavailable("hours", "No complete lifecycle observations.");
  return measured("hours", values.reduce((total, value) => total + value, 0) / values.length, null, values.length);
}

function disagreementMetric(repository, changes) {
  if (!hasComparableCiEvidence(repository)) {
    return unavailable("ratio", "Exact validation or hosted CI evidence unavailable.");
  }
  const comparable = changes.filter(hasComparableResults);
  if (comparable.length === 0) return unavailable("ratio", "No comparable validation outcomes.");
  const disagreements = comparable.filter((change) => change.validationStatus !== change.hostedStatus).length;
  return ratio(disagreements, comparable.length);
}

function deliveryChangeCount(repository, changes) {
  return available(repository, ["plane", "github"])
    ? measured("count", changes.length)
    : unavailable("count", "Plane or GitHub evidence unavailable.");
}

function traceabilityMetric(repository, changes, linked) {
  if (!available(repository, ["plane", "github"])) {
    return unavailable("ratio", "No provider-backed delivery changes.");
  }
  return changes.length > 0
    ? ratio(linked.length, changes.length)
    : unavailable("ratio", "No provider-backed delivery changes.");
}

function isLinkedChange(change) {
  if (!isPlainObject(change)) return false;
  return change.linkBasis !== "unlinked" && validLinkedRelationship(change);
}

function validPullRequestNumber(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validLinkedRelationship(change) {
  return isPortableIdentifier(change.planeStoryId)
    && validPullRequestNumber(change.pullRequestNumber);
}

function validUnlinkedRelationship(change) {
  return allNull([change.linkEvidence, change.planeStoryId, change.pullRequestNumber]);
}

function validateSourcePayload(source) {
  return source.status === "available"
    ? validateAvailableSource(source)
    : validateUnavailableSource(source);
}

function versionNotAfterObservation(source) {
  return !isDateTime(source.sourceVersion)
    || Date.parse(source.sourceVersion) <= Date.parse(source.observedAt);
}

function validGitSourceVersion(source) {
  return !GIT_BACKED_SYSTEMS.has(source.system)
    || matches(COMMIT_PATTERN, source.sourceVersion);
}

function validProviderSourceVersion(source) {
  return !PROVIDER_SYSTEMS.has(source.system)
    || (typeof source.sourceVersion === "string" && isSafeProviderVersion(source.sourceVersion));
}

function validDurationPair(change, startField, endField) {
  return isDateTime(change?.[startField]) && isDateTime(change?.[endField]);
}

function hasComparableCiEvidence(repository) {
  return available(repository, ["tabellio-validation"])
    && availableAny(repository, ["github-actions", "buildkite"]);
}

function hasComparableResults(change) {
  const results = ["passed", "failed"];
  return results.includes(change?.validationStatus)
    && results.includes(change?.hostedStatus);
}

function available(repository, systems) {
  return systems.every((system) =>
    repositorySources(repository).some((source) =>
      source?.system === system && source.status === "available"
    )
  );
}

function availableAny(repository, systems) {
  return systems.some((system) =>
    repositorySources(repository).some((source) =>
      source?.system === system && source.status === "available"
    )
  );
}

function repositorySources(repository) {
  return Array.isArray(repository?.sources) ? repository.sources : [];
}

function measured(unit, value, numerator = null, denominator = null) {
  return { status: "measured", value, unit, reason: null, numerator, denominator };
}

function ratio(numerator, denominator) {
  return measured("ratio", numerator / denominator, numerator, denominator);
}

function unavailable(unit, reason) {
  return { status: "unavailable", value: null, unit, reason, numerator: null, denominator: null };
}

function digestDataset(dataset) {
  const unsigned = structuredClone(dataset);
  delete unsigned.integrity;
  return createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
}

function validWindow(window, observedAt) {
  if (!isPlainObject(window)) return false;
  return ruleErrors([
    [Object.keys(window).length === 2, "fields"],
    [isDateTime(window.since), "since"],
    [isDateTime(window.until), "until"],
    [dateBefore(window.since, window.until), "order"],
    [dateAtOrBefore(window.until, observedAt), "observation"],
  ]).length === 0;
}

function isDateTime(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function normalizeDateTime(value) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error("Git returned an invalid timestamp.");
  return new Date(timestamp).toISOString();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string";
}

function isNonNull(value) {
  return value !== null;
}

function matches(pattern, value) {
  return typeof value === "string" && pattern.test(value);
}

function isAtOrBefore(value, upperBound) {
  return isDateTime(value) && dateAtOrBefore(value, upperBound);
}

function optionalDateAtOrBefore(value, upperBound) {
  return value === null || isAtOrBefore(value, upperBound);
}

function dateBefore(left, right) {
  return Date.parse(left) < Date.parse(right);
}

function dateAtOrBefore(left, right) {
  return Date.parse(left) <= Date.parse(right);
}

function nullableSafeText(value) {
  return value === null || isSafeProviderText(value);
}

function allNull(values) {
  return values.every((value) => value === null);
}

function requiredArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function ruleErrors(rules) {
  return rules.filter(([valid]) => !valid).map(([, error]) => error);
}

function assertRules(rules) {
  const errors = ruleErrors(rules);
  if (errors.length > 0) throw new Error(errors[0]);
}

function duplicateValueErrors(items, select, isValid, message) {
  const seen = new Set();
  return items.flatMap((item, index) => {
    const value = select(item);
    if (!isValid(value)) return [];
    if (seen.has(value)) return [message(index)];
    seen.add(value);
    return [];
  });
}

function rejectUnknownFields(value, allowed, label, errors) {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) errors.push(`${label} contains a field that is not allowed.`);
  }
}

function prefix(label, errors) {
  return errors.map((error) => `${label}: ${error}`);
}

function unique(values) {
  return [...new Set(values)];
}
