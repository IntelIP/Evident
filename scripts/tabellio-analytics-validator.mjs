#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  recomputeDeliveryMetrics,
  validateAnalyticsDataset,
} from "./lib/analytics.mjs";
import { canonicalJson } from "./lib/context-packet.mjs";
import { reportCliError } from "./lib/cli-options.mjs";
import {
  canonicalCandidatePath,
  pathState,
  sameFile,
} from "./lib/output-safety.mjs";
import {
  canonicalRepositoryId,
  hasCredentialShape,
  validateProviderSnapshot,
} from "./lib/portable-evidence.mjs";
import { validateValidationResult } from "./lib/validation-runner.mjs";

const PROFILES = new Set(["schema", "semantic", "workflow", "operational", "security"]);
const REPEATABLE_OPTIONS = new Set(["source", "validationEvidence", "requiredRepository"]);
const ALLOWED_OPTIONS = new Set([
  "profile",
  "validatorId",
  "dataset",
  "source",
  "validationEvidence",
  "requiredRepository",
  "expectedDigest",
  "out",
  "exitMode",
]);
const PROVIDER_SYSTEMS = ["plane", "github", "github-actions", "buildkite"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|authorization|access[_-]?token|client[_-]?secret|private[_-]?key|password|token|secret)\s*[=:]/i,
  /file:/i,
  /(?:^|[\s=:(])~(?:\/|$)/,
  /(?:^|[\s=:(\['"`])\.\.?[\\/]\S*/,
  /(?:^|[^A-Za-z0-9/])\/(?:Users|private|tmp|home|var|etc)\//i,
  /(?:^|[^A-Za-z0-9+.-])[A-Za-z]:[\\/]+\S+/,
  /(?:^|[^\\])\\\\[^\\\s]+\\/,
];
const PROFILE_RUNNERS = {
  schema: schemaProfile,
  semantic: semanticProfile,
  workflow: workflowProfile,
  operational: operationalProfile,
  security: securityProfile,
};

try {
  const options = parseOptions(process.argv.slice(2));
  validateOptions(options);
  const datasetPath = resolve(options.dataset);
  const sourcePaths = options.source.map((value) => resolve(value));
  const validationPaths = options.validationEvidence.map((value) => resolve(value));
  const outputPath = await safeOutputPath(
    options.out,
    [datasetPath, ...sourcePaths, ...validationPaths],
  );
  const datasetInput = await readJsonInput(datasetPath, "Dataset");
  const sourceInputs = await Promise.all(
    sourcePaths.map((sourcePath) => readJsonInput(sourcePath, "Provider snapshot"))
  );
  const validationInputs = await Promise.all(
    validationPaths.map((validationPath) =>
      readJsonInput(validationPath, "Validation evidence")
    )
  );
  const inputErrors = [
    ...datasetInput.errors,
    ...sourceInputs.flatMap((input) => input.errors),
    ...validationInputs.flatMap((input) => input.errors),
  ];
  const dataset = datasetInput.value;
  const snapshots = sourceInputs
    .map((input) => input.value)
    .filter((value) => value !== null);
  const validationEvidence = validationInputs
    .map((input) => input.value)
    .filter((value) => value !== null);

  validateExpectedDigest(options.expectedDigest, dataset, inputErrors);
  validateRequiredRepositoryOptions(options.requiredRepository, inputErrors);
  validateDatasetInput(dataset, inputErrors);
  validateSnapshotInputs(snapshots, dataset, inputErrors);
  validateValidationEvidenceInputs(validationEvidence, dataset, inputErrors);
  rejectDuplicateSnapshots(snapshots, inputErrors);
  rejectDuplicateValidationEvidence(validationEvidence, inputErrors);

  const startedAt = performance.now();
  const profileResult = inputErrors.length === 0
    ? runProfile(options.profile, {
        dataset,
        snapshots,
        validationEvidence,
        requiredRepositories: normalizedRequiredRepositories(options.requiredRepository),
        rawInputs: [
          datasetInput.raw,
          ...sourceInputs.map((input) => input.raw),
          ...validationInputs.map((input) => input.raw),
        ].filter(Boolean),
      })
    : blockedProfileResult(options.profile);
  const durationMs = performance.now() - startedAt;
  const status = inputErrors.length > 0
    ? "blocked"
    : profileResult.errors.length > 0 ? "failed" : "passed";
  const evidence = {
    schemaVersion: "tabellio-validator-evidence/v0.1",
    validatorId: options.validatorId,
    status,
    summary: evidenceSummary(options.profile, status, inputErrors.length + profileResult.errors.length),
    metrics: profileMetrics(options.profile, status, profileResult, durationMs),
    cost: { telemetry: "available", usd: 0, modelCalls: 0, toolCalls: 0 },
    artifacts: [
      artifact("analytics-dataset", datasetInput.bytes),
      ...sourceInputs.map((input, index) =>
        artifact(`provider-snapshot-${index + 1}`, input.bytes)
      ),
      ...validationInputs.map((input, index) =>
        artifact(`validation-evidence-${index + 1}`, input.bytes)
      ),
    ].filter(Boolean),
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({
    ok: status === "passed",
    profile: options.profile,
    status,
  })}\n`);
  if (status !== "passed" && options.exitMode !== "evidence") process.exitCode = 1;
} catch (error) {
  reportCliError(error);
}

function parseOptions(args) {
  assertPairedOptions(args);
  const options = { source: [], validationEvidence: [], requiredRepository: [] };
  for (let index = 0; index < args.length; index += 2) {
    assignOption(options, optionKey(args[index]), args[index + 1]);
  }
  return options;
}

function validateOptions(options) {
  ["profile", "validatorId", "dataset", "out"].forEach((key) =>
    assertRequiredOption(options, key)
  );
  assertSupportedProfile(options.profile);
  assertSafeValidatorId(options.validatorId);
  assertExitMode(options.exitMode);
  assertSemanticRepositories(options);
}

function assertPairedOptions(args) {
  if (args.length % 2 !== 0) throw new Error("Analytics validator options require values.");
}

function optionKey(flag) {
  if (typeof flag !== "string" || !flag.startsWith("--")) {
    throw new Error("Analytics validator options are invalid.");
  }
  const key = flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
  if (!ALLOWED_OPTIONS.has(key)) throw new Error("Analytics validator option is unsupported.");
  return key;
}

function assignOption(options, key, value) {
  if (REPEATABLE_OPTIONS.has(key)) {
    options[key].push(value);
    return;
  }
  if (Object.hasOwn(options, key)) throw new Error("Analytics validator option is duplicated.");
  options[key] = value;
}

function assertRequiredOption(options, key) {
  if (typeof options[key] === "string" && options[key] !== "") return;
  const flag = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  throw new Error(`--${flag} is required.`);
}

function assertSupportedProfile(profile) {
  if (!PROFILES.has(profile)) throw new Error("Analytics validator profile is unsupported.");
}

function assertSafeValidatorId(validatorId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(validatorId)) {
    throw new Error("Analytics validator id is invalid.");
  }
}

function assertExitMode(exitMode) {
  if (exitMode !== undefined && exitMode !== "evidence") {
    throw new Error("Analytics validator exit mode is unsupported.");
  }
}

function assertSemanticRepositories(options) {
  if (options.profile === "semantic" && options.requiredRepository.length === 0) {
    throw new Error("Semantic validation requires --required-repository.");
  }
}

async function readJsonInput(path, label) {
  try {
    const bytes = await readFile(path);
    const raw = bytes.toString("utf8");
    try {
      const value = JSON.parse(raw);
      return {
        bytes,
        raw,
        value,
        errors: value === null ? [`${label} must be an object.`] : [],
      };
    } catch {
      return { bytes, raw, value: null, errors: [`${label} JSON is invalid.`] };
    }
  } catch {
    return { bytes: null, raw: null, value: null, errors: [`${label} is unavailable.`] };
  }
}

function validateExpectedDigest(expectedDigest, dataset, errors) {
  if (expectedDigest === undefined) return;
  validateExpectedDigestShape(expectedDigest, errors);
  validateExpectedDigestBinding(expectedDigest, dataset, errors);
}

function validateExpectedDigestShape(expectedDigest, errors) {
  if (!SHA256_PATTERN.test(expectedDigest)) errors.push("Expected dataset digest is invalid.");
}

function validateExpectedDigestBinding(expectedDigest, dataset, errors) {
  if (dataset === null) return;
  if (dataset.integrity?.digest !== expectedDigest) {
    errors.push("Dataset digest does not match the expected digest.");
  }
}

function validateRequiredRepositoryOptions(values, errors) {
  const normalized = values.map(canonicalRepositoryId);
  if (normalized.some((value) => value === null)) {
    errors.push("Required repository identity is invalid.");
  }
  if (new Set(normalized).size !== normalized.length) {
    errors.push("Required repository identities must be unique.");
  }
}

function normalizedRequiredRepositories(values) {
  return values.map(canonicalRepositoryId).filter(Boolean).sort();
}

function validateDatasetInput(dataset, errors) {
  if (dataset === null) return;
  errors.push(...captureValidation(() => validateAnalyticsDataset(dataset)));
}

function validateSnapshotInputs(snapshots, dataset, errors) {
  errors.push(...snapshots.flatMap((snapshot) =>
    validateProviderSnapshot(snapshot, {
      repository: snapshot?.repository,
      headCommit: snapshot?.headCommit,
      observedAt: dataset?.observedAt,
    }).map(() => "Provider snapshot contract is invalid.")
  ));
}

function validateValidationEvidenceInputs(values, dataset, errors) {
  errors.push(...values.flatMap((value) =>
    captureValidation(() => validateValidationEvidenceInput(value, dataset))
  ));
}

function validateValidationEvidenceInput(value, dataset) {
  assertExactKeys(
    value,
    ["schemaVersion", "repository", "controlVersion", "result"],
    "Validation evidence",
  );
  assertValidationEvidenceSchema(value.schemaVersion);
  assertValidationEvidenceRepository(value.repository);
  assertValidationControlVersion(value.controlVersion);
  validateValidationResult(value.result);
  assertValidationEvidenceTime(value.result.completedAt, dataset?.observedAt);
}

function assertValidationEvidenceSchema(schemaVersion) {
  if (schemaVersion !== "tabellio-analytics-validation-evidence/v0.1") {
    throw new Error("Validation evidence schema is unsupported.");
  }
}

function assertValidationEvidenceRepository(repository) {
  if (canonicalRepositoryId(repository) === null) {
    throw new Error("Validation evidence repository is invalid.");
  }
}

function assertValidationControlVersion(controlVersion) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(controlVersion)) {
    throw new Error("Validation evidence control version is invalid.");
  }
}

function assertValidationEvidenceTime(completedAt, observedAt) {
  if (Date.parse(completedAt) > Date.parse(observedAt)) {
    throw new Error("Validation evidence is newer than the dataset.");
  }
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  if (canonicalJson(actual) !== canonicalJson([...expected].sort())) {
    throw new Error(`${label} fields are invalid.`);
  }
}

function assertPlainObject(value, label) {
  if (value === null) throw new Error(`${label} must be an object.`);
  if (typeof value !== "object") throw new Error(`${label} must be an object.`);
  if (Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function rejectDuplicateSnapshots(snapshots, errors) {
  const repositories = snapshots.map((snapshot) => canonicalRepositoryId(snapshot?.repository));
  if (repositories.some((repository, index) =>
    repository !== null && repositories.indexOf(repository) !== index
  )) {
    errors.push("Provider snapshot repositories must be unique.");
  }
}

function rejectDuplicateValidationEvidence(values, errors) {
  const repositories = values.map((value) => canonicalRepositoryId(value?.repository));
  if (repositories.some((repository, index) =>
    repository !== null && repositories.indexOf(repository) !== index
  )) {
    errors.push("Validation evidence repositories must be unique.");
  }
}

function runProfile(profile, context) {
  try {
    return PROFILE_RUNNERS[profile](context);
  } catch {
    return { errors: ["Profile execution failed."], repositoryCount: 0, traceCount: 0, snapshotCount: 0 };
  }
}

function schemaProfile({ dataset, snapshots }) {
  const errors = [
    ...captureValidation(() => validateAnalyticsDataset(dataset)),
    ...snapshots.flatMap((snapshot) =>
      validateProviderSnapshot(snapshot, {
        repository: snapshot.repository,
        headCommit: snapshot.headCommit,
        observedAt: dataset.observedAt,
      })
    ),
  ];
  return { errors, repositoryCount: 0, traceCount: 0, snapshotCount: snapshots.length };
}

function semanticProfile({ dataset, snapshots, validationEvidence, requiredRepositories }) {
  const repositories = Array.isArray(dataset.repositories) ? dataset.repositories : [];
  const collected = repositories.filter(hasCollectedGitEvidence);
  const collectedIds = [...new Set(
    collected.map((repository) => canonicalRepositoryId(repository.canonicalRepositoryId))
  )].filter(Boolean).sort();
  const traces = repositories.flatMap((repository) =>
    Array.isArray(repository.deliveryChanges) ? repository.deliveryChanges : []
  );
  const linkedTraces = traces.filter(isLinkedTrace);
  const errors = [
    ...bindingErrors(dataset, snapshots, validationEvidence, requiredRepositories),
    ...repositories.flatMap((repository) =>
      canonicalJson(repository.metrics) === canonicalJson(
        recomputeDeliveryMetrics(repository, dataset.window)
      )
        ? []
        : ["Repository delivery metrics do not match trace rows."]
    ),
  ];
  if (canonicalJson(collectedIds) !== canonicalJson(requiredRepositories)) {
    errors.push("Collected repository set does not match the required repository set.");
  }
  if (linkedTraces.length === 0) errors.push("At least one linked delivery trace is required.");
  return {
    errors,
    repositoryCount: collectedIds.length,
    traceCount: traces.length,
    snapshotCount: snapshots.length,
  };
}

function workflowProfile({ dataset, snapshots, validationEvidence }) {
  const errors = bindingErrors(dataset, snapshots, validationEvidence, []);
  return {
    errors,
    repositoryCount: dataset.repositories.length,
    traceCount: dataset.repositories.reduce(
      (count, repository) => count + repository.deliveryChanges.length,
      0,
    ),
    snapshotCount: snapshots.length,
  };
}

function operationalProfile({ dataset }) {
  const startedAt = performance.now();
  const errors = [];
  for (let index = 0; index < 25; index += 1) {
    errors.push(...captureValidation(() => {
      validateAnalyticsDataset(dataset);
      for (const repository of dataset.repositories) {
        recomputeDeliveryMetrics(repository, dataset.window);
      }
    }));
  }
  const projectionDurationMs = performance.now() - startedAt;
  if (projectionDurationMs > 1_000) {
    errors.push("Twenty-five analytics projections exceed the local duration budget.");
  }
  return {
    errors,
    repositoryCount: dataset.repositories.length,
    traceCount: 0,
    snapshotCount: 0,
    projectionDurationMs,
  };
}

function securityProfile({ dataset, snapshots, validationEvidence, rawInputs }) {
  const decodedStrings = stringsIn([dataset, ...snapshots, ...validationEvidence]);
  const rawStrings = rawInputs.flatMap((raw) => [raw]);
  const errors = [...decodedStrings, ...rawStrings]
    .flatMap((value) => sensitiveEvidence(value) ? ["Private evidence text is forbidden."] : []);
  return {
    errors,
    repositoryCount: dataset.repositories.length,
    traceCount: 0,
    snapshotCount: snapshots.length,
  };
}

function bindingErrors(dataset, snapshots, validationEvidence, requiredRepositories) {
  const repositories = new Map(
    dataset.repositories.map((repository) => [
      canonicalRepositoryId(repository.canonicalRepositoryId),
      repository,
    ])
  );
  const snapshotMap = new Map(
    snapshots.map((snapshot) => [canonicalRepositoryId(snapshot.repository), snapshot])
  );
  const validationMap = new Map(
    validationEvidence.map((value) => [canonicalRepositoryId(value.repository), value])
  );
  return [
    ...unknownSnapshotErrors(repositories, snapshotMap),
    ...unknownValidationEvidenceErrors(repositories, validationMap),
    ...dataset.repositories.flatMap((repository) =>
      repositoryBindingErrors(
        dataset,
        repository,
        snapshotMap,
        validationMap,
        requiredRepositories,
      )
    ),
    ...requiredSnapshotErrors(snapshotMap, requiredRepositories),
  ];
}

function unknownValidationEvidenceErrors(repositories, validationMap) {
  return [...validationMap.keys()].flatMap((repositoryId) =>
    repositories.has(repositoryId) ? [] : ["Validation evidence has no dataset repository."]
  );
}

function unknownSnapshotErrors(repositories, snapshotMap) {
  return [...snapshotMap.keys()].flatMap((repositoryId) =>
    repositories.has(repositoryId) ? [] : ["Provider snapshot has no dataset repository."]
  );
}

function repositoryBindingErrors(
  dataset,
  repository,
  snapshotMap,
  validationMap,
  requiredRepositories,
) {
  const repositoryId = canonicalRepositoryId(repository.canonicalRepositoryId);
  const snapshot = snapshotMap.get(repositoryId);
  if (snapshot) {
    return providerBindingErrors(
      dataset,
      repository,
      snapshot,
      validationMap.get(repositoryId),
    );
  }
  const required = requiredRepositories.includes(repositoryId);
  return [required, providerEvidenceRequiresSnapshot(repository)].some(Boolean)
    ? ["Repository provider evidence lacks a bound snapshot."]
    : [];
}

function requiredSnapshotErrors(snapshotMap, requiredRepositories) {
  return requiredRepositories.flatMap((repositoryId) =>
    snapshotMap.has(repositoryId) ? [] : ["Required repository lacks a provider snapshot."]
  );
}

function providerBindingErrors(dataset, repository, snapshot, validationEvidence) {
  return [
    ...validateProviderSnapshot(snapshot, {
    repository: repository.canonicalRepositoryId,
    headCommit: repository.headCommit,
    observedAt: dataset.observedAt,
    }).map(() => "Provider snapshot does not bind the dataset repository."),
    ...PROVIDER_SYSTEMS.flatMap((system) => sourceBindingErrors(repository, snapshot, system)),
    ...deliveryTraceBindingErrors(dataset, repository, snapshot),
    ...validationEvidenceBindingErrors(
      dataset,
      repository,
      snapshot,
      validationEvidence,
    ),
  ];
}

function deliveryTraceBindingErrors(dataset, repository, snapshot) {
  const expectedChanges = snapshot.deliveryChanges
    .filter((change) => deliveryChangeWithinWindow(change, dataset.window))
    .map(normalizeProviderChange)
    .sort(compareIds);
  const actualChanges = structuredClone(repository.deliveryChanges).sort(compareIds);
  return canonicalJson(actualChanges) === canonicalJson(expectedChanges)
    ? []
    : ["Dataset delivery traces do not match the provider snapshot."];
}

function normalizeProviderChange(change) {
  const normalized = structuredClone(change);
  delete normalized.mergeCommit;
  delete normalized.releaseCommit;
  normalized.releasedAt = null;
  return normalized;
}

function validationEvidenceBindingErrors(dataset, repository, snapshot, evidence) {
  const exactStatuses = exactValidationStatuses(dataset, snapshot);
  const availabilityError = validationEvidenceAvailabilityError(
    repository,
    evidence,
    exactStatuses,
  );
  if (availabilityError !== null) return [availabilityError];
  if (evidence === undefined) return [];
  return [
    ...validationEvidenceIdentityErrors(repository, evidence),
    ...validationEvidenceDigestErrors(repository, evidence),
    ...validationStatusBindingErrors(exactStatuses, evidence),
  ];
}

function exactValidationStatuses(dataset, snapshot) {
  return snapshot.deliveryChanges
    .filter((change) => deliveryChangeWithinWindow(change, dataset.window))
    .map((change) => change.validationStatus)
    .filter((status) => status !== "unavailable");
}

function validationEvidenceAvailabilityError(repository, evidence, exactStatuses) {
  const sourceAvailable = availableSource(repository, "tabellio-validation");
  const evidenceRequired = [sourceAvailable, exactStatuses.length > 0].some(Boolean);
  const evidenceBound = [sourceAvailable, evidence !== undefined].every(Boolean);
  return [evidenceRequired, !evidenceBound].every(Boolean)
    ? "Exact validation status lacks validation evidence."
    : null;
}

function validationStatusBindingErrors(exactStatuses, evidence) {
  return exactStatuses.flatMap((status) =>
      status === evidence.result.status
        ? []
        : ["Validation status does not match exact validation evidence."]
  );
}

function validationEvidenceIdentityErrors(repository, evidence) {
  const resultRepository = normalizedValidationRepository(evidence.result.repository.id);
  return [
    resultRepository === canonicalRepositoryId(repository.canonicalRepositoryId)
      ? []
      : ["Validation evidence repository does not match."],
    evidence.result.revision.headCommit === repository.headCommit
      ? []
      : ["Validation evidence head does not match."],
  ].flat();
}

function validationEvidenceDigestErrors(repository, evidence) {
  const source = repository.sources.find((value) =>
    value?.system === "tabellio-validation"
  );
  const expectedDigest = sha256(canonicalJson({
    records: [evidence.result],
    version: evidence.controlVersion,
  }));
  return source?.contentDigest === expectedDigest
    ? []
    : ["Validation source digest does not match exact validation evidence."];
}

function normalizedValidationRepository(value) {
  if (typeof value !== "string") return null;
  const direct = canonicalRepositoryId(value);
  if (direct !== null) return direct;
  return value.toLowerCase().startsWith("github.com/")
    ? canonicalRepositoryId(value.slice("github.com/".length))
    : null;
}

function deliveryChangeWithinWindow(change, window) {
  const timestamp = [change.mergedAt, change.firstActivityAt, change.storyCreatedAt]
    .find((value) => value !== null);
  if (typeof timestamp !== "string") return false;
  const value = Date.parse(timestamp);
  return [
    value >= Date.parse(window.since),
    value <= Date.parse(window.until),
  ].every(Boolean);
}

function sourceBindingErrors(repository, snapshot, system) {
  const actual = repository.sources.find((source) => source?.system === system);
  const expected = snapshot.sources[system];
  if (!actual || !expected) return ["Provider source binding is missing."];
  const errors = commonSourceBindingErrors(actual, expected, snapshot.capturedAt);
  return expected.status === "available"
    ? [...errors, ...availableSourceBindingErrors(actual, expected)]
    : [...errors, ...unavailableSourceBindingErrors(actual, expected)];
}

function commonSourceBindingErrors(actual, expected, capturedAt) {
  const errors = [];
  if (actual.status !== expected.status) errors.push("Provider source status does not match.");
  if (actual.observedAt !== capturedAt) {
    errors.push("Provider source observation does not match.");
  }
  return errors;
}

function availableSourceBindingErrors(actual, expected) {
  const errors = [];
  if (actual.sourceVersion !== expected.version) {
    errors.push("Provider source version does not match.");
  }
  if (actual.contentDigest !== sha256(canonicalJson(expected))) {
    errors.push("Provider source digest does not match.");
  }
  if (actual.reason !== null) errors.push("Available provider source carries a reason.");
  return errors;
}

function unavailableSourceBindingErrors(actual, expected) {
  const errors = [];
  if ([actual.sourceVersion, actual.contentDigest].some((value) => value !== null)) {
    errors.push("Unavailable provider source carries available evidence.");
  }
  if (actual.reason !== expected.reason) {
    errors.push("Unavailable provider source reason does not match.");
  }
  return errors;
}

function providerEvidenceRequiresSnapshot(repository) {
  return repository.deliveryChanges.length > 0
    || repository.sources.some((source) =>
      PROVIDER_SYSTEMS.includes(source?.system) && source.status !== "unavailable"
    );
}

function hasCollectedGitEvidence(repository) {
  return repository.sources.some((source) =>
    source?.system === "git"
    && source.status === "available"
    && source.sourceVersion === repository.headCommit
  );
}

function isLinkedTrace(change) {
  return [
    change?.linkBasis !== "unlinked",
    typeof change?.planeStoryId === "string",
    Number.isInteger(change?.pullRequestNumber),
  ].every(Boolean);
}

function availableSource(repository, system) {
  return repository.sources.some((source) =>
    source?.system === system && source.status === "available"
  );
}

function compareIds(left, right) {
  return String(left?.id).localeCompare(String(right?.id));
}

function blockedProfileResult(profile) {
  return {
    errors: [],
    repositoryCount: 0,
    traceCount: 0,
    snapshotCount: 0,
    projectionDurationMs: 0,
  };
}

function evidenceSummary(profile, status, issueCount) {
  if (status === "passed") return `Analytics ${profile} validation passed.`;
  if (status === "blocked") {
    return `Analytics ${profile} validation blocked by ${issueCount} invalid or unavailable input(s).`;
  }
  return `Analytics ${profile} validation failed with ${issueCount} contract issue(s).`;
}

function profileMetrics(profile, status, result, durationMs) {
  const pass = status === "passed" ? 1 : 0;
  const common = [
    { name: "analytics_validator_duration_ms", value: durationMs, unit: "milliseconds" },
  ];
  const metrics = {
    schema: () => [
      { name: "analytics_validator_schema_pass", value: pass, unit: "boolean" },
    ],
    semantic: () => [
      { name: "analytics_validator_semantic_pass", value: pass, unit: "boolean" },
      { name: "analytics_repository_count", value: result.repositoryCount, unit: "count" },
      { name: "analytics_trace_count", value: result.traceCount, unit: "count" },
    ],
    workflow: () => [
      { name: "analytics_validator_workflow_pass", value: pass, unit: "boolean" },
      { name: "analytics_snapshot_count", value: result.snapshotCount, unit: "count" },
    ],
    operational: () => [
      {
        name: "analytics_projection_25x_duration_ms",
        value: result.projectionDurationMs ?? 0,
        unit: "milliseconds",
      },
    ],
    security: () => [
      { name: "analytics_validator_security_pass", value: pass, unit: "boolean" },
    ],
  };
  return [...metrics[profile](), ...common];
}

function stringsIn(value) {
  const strings = [];
  visit(value, strings);
  return strings;
}

function visit(value, strings) {
  if (typeof value === "string") {
    strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => visit(entry, strings));
    return;
  }
  visitObject(value, strings);
}

function visitObject(value, strings) {
  if (value === null) return;
  if (typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    strings.push(key);
    visit(entry, strings);
  }
}

function sensitiveEvidence(value) {
  return [hasCredentialShape(value), SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))]
    .some(Boolean);
}

function artifact(name, bytes) {
  if (bytes === null) return null;
  const digest = sha256(bytes);
  return {
    name,
    uri: `urn:tabellio:analytics-validator:${name}:${digest}`,
    digest,
    mediaType: "application/json",
    bytes: bytes.byteLength,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function captureValidation(action) {
  try {
    action();
    return [];
  } catch {
    return ["Analytics contract validation failed."];
  }
}

async function safeOutputPath(output, protectedInputs) {
  const outputPath = resolve(output);
  assertNoLexicalInputAlias(outputPath, protectedInputs);
  const outputState = await pathState(outputPath);
  assertOutputNotSymlink(outputState);
  const outputCandidate = await canonicalCandidatePath(outputPath, outputState);
  await Promise.all(protectedInputs.map((input) =>
    assertInputNotAliased(input, outputCandidate, outputState)
  ));
  return outputPath;
}

function assertNoLexicalInputAlias(outputPath, protectedInputs) {
  if (protectedInputs.some((input) => outputPath === resolve(input))) {
    throw new Error("Validator output must not alias an input.");
  }
}

function assertOutputNotSymlink(outputState) {
  if (outputState?.symbolicLink) throw new Error("Validator output must not be a symbolic link.");
}

async function assertInputNotAliased(input, outputCandidate, outputState) {
  const inputState = await unavailableInputState(input);
  if (inputState === null) return;
  const inputCandidate = await canonicalCandidatePath(input, inputState);
  if ([outputCandidate === inputCandidate, sameFile(outputState, inputState)].some(Boolean)) {
    throw new Error("Validator output must not alias an input.");
  }
}

async function unavailableInputState(input) {
  try {
    return await pathState(input);
  } catch (error) {
    if (["EACCES", "ENOENT", "ENOTDIR"].includes(error?.code)) return null;
    throw error;
  }
}
