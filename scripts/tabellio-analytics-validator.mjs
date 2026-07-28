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

const PROFILES = new Set(["schema", "semantic", "workflow", "operational", "security"]);
const REPEATABLE_OPTIONS = new Set(["source", "requiredRepository"]);
const ALLOWED_OPTIONS = new Set([
  "profile",
  "validatorId",
  "dataset",
  "source",
  "requiredRepository",
  "expectedDigest",
  "out",
  "exitMode",
]);
const PROVIDER_SYSTEMS = ["plane", "github", "github-actions", "buildkite"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

try {
  const options = parseOptions(process.argv.slice(2));
  validateOptions(options);
  const datasetPath = resolve(options.dataset);
  const sourcePaths = options.source.map((value) => resolve(value));
  const outputPath = await safeOutputPath(options.out, [datasetPath, ...sourcePaths]);
  const datasetInput = await readJsonInput(datasetPath, "Dataset");
  const sourceInputs = await Promise.all(
    sourcePaths.map((sourcePath) => readJsonInput(sourcePath, "Provider snapshot"))
  );
  const inputErrors = [
    ...datasetInput.errors,
    ...sourceInputs.flatMap((input) => input.errors),
  ];
  const dataset = datasetInput.value;
  const snapshots = sourceInputs
    .map((input) => input.value)
    .filter((value) => value !== null);

  validateExpectedDigest(options.expectedDigest, dataset, inputErrors);
  validateRequiredRepositoryOptions(options.requiredRepository, inputErrors);
  validateDatasetInput(dataset, inputErrors);
  validateSnapshotInputs(snapshots, dataset, inputErrors);
  rejectDuplicateSnapshots(snapshots, inputErrors);

  const startedAt = performance.now();
  const profileResult = inputErrors.length === 0
    ? runProfile(options.profile, {
        dataset,
        snapshots,
        requiredRepositories: normalizedRequiredRepositories(options.requiredRepository),
        rawInputs: [datasetInput.raw, ...sourceInputs.map((input) => input.raw)].filter(Boolean),
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
  if (args.length % 2 !== 0) throw new Error("Analytics validator options require values.");
  const options = { source: [], requiredRepository: [] };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--")) {
      throw new Error("Analytics validator options are invalid.");
    }
    const key = flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (!ALLOWED_OPTIONS.has(key)) throw new Error("Analytics validator option is unsupported.");
    if (REPEATABLE_OPTIONS.has(key)) {
      options[key].push(value);
    } else {
      if (Object.hasOwn(options, key)) throw new Error("Analytics validator option is duplicated.");
      options[key] = value;
    }
  }
  return options;
}

function validateOptions(options) {
  for (const key of ["profile", "validatorId", "dataset", "out"]) {
    if (typeof options[key] !== "string" || options[key] === "") {
      throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required.`);
    }
  }
  if (!PROFILES.has(options.profile)) throw new Error("Analytics validator profile is unsupported.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.validatorId)) {
    throw new Error("Analytics validator id is invalid.");
  }
  if (options.exitMode !== undefined && options.exitMode !== "evidence") {
    throw new Error("Analytics validator exit mode is unsupported.");
  }
  if (options.profile === "semantic" && options.requiredRepository.length === 0) {
    throw new Error("Semantic validation requires --required-repository.");
  }
}

async function readJsonInput(path, label) {
  try {
    const bytes = await readFile(path);
    const raw = bytes.toString("utf8");
    try {
      return { bytes, raw, value: JSON.parse(raw), errors: [] };
    } catch {
      return { bytes, raw, value: null, errors: [`${label} JSON is invalid.`] };
    }
  } catch {
    return { bytes: null, raw: null, value: null, errors: [`${label} is unavailable.`] };
  }
}

function validateExpectedDigest(expectedDigest, dataset, errors) {
  if (expectedDigest === undefined) return;
  if (!SHA256_PATTERN.test(expectedDigest)) {
    errors.push("Expected dataset digest is invalid.");
  } else if (dataset !== null && dataset?.integrity?.digest !== expectedDigest) {
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
  for (const snapshot of snapshots) {
    const snapshotErrors = validateProviderSnapshot(snapshot, {
      repository: snapshot?.repository,
      headCommit: snapshot?.headCommit,
      observedAt: dataset?.observedAt,
    });
    errors.push(...snapshotErrors.map(() => "Provider snapshot contract is invalid."));
  }
}

function rejectDuplicateSnapshots(snapshots, errors) {
  const repositories = snapshots.map((snapshot) => canonicalRepositoryId(snapshot?.repository));
  if (repositories.some((repository, index) =>
    repository !== null && repositories.indexOf(repository) !== index
  )) {
    errors.push("Provider snapshot repositories must be unique.");
  }
}

function runProfile(profile, context) {
  try {
    if (profile === "schema") return schemaProfile(context);
    if (profile === "semantic") return semanticProfile(context);
    if (profile === "workflow") return workflowProfile(context);
    if (profile === "operational") return operationalProfile(context);
    return securityProfile(context);
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

function semanticProfile({ dataset, snapshots, requiredRepositories }) {
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
    ...bindingErrors(dataset, snapshots, requiredRepositories),
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

function workflowProfile({ dataset, snapshots }) {
  const errors = bindingErrors(dataset, snapshots, []);
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

function securityProfile({ dataset, snapshots, rawInputs }) {
  const decodedStrings = stringsIn([dataset, ...snapshots]);
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

function bindingErrors(dataset, snapshots, requiredRepositories) {
  const repositories = new Map(
    dataset.repositories.map((repository) => [
      canonicalRepositoryId(repository.canonicalRepositoryId),
      repository,
    ])
  );
  const snapshotMap = new Map(
    snapshots.map((snapshot) => [canonicalRepositoryId(snapshot.repository), snapshot])
  );
  const errors = [];
  for (const repositoryId of snapshotMap.keys()) {
    if (!repositories.has(repositoryId)) errors.push("Provider snapshot has no dataset repository.");
  }
  for (const repository of dataset.repositories) {
    const repositoryId = canonicalRepositoryId(repository.canonicalRepositoryId);
    const snapshot = snapshotMap.get(repositoryId);
    const required = requiredRepositories.includes(repositoryId);
    if (!snapshot) {
      if (required || providerEvidenceRequiresSnapshot(repository)) {
        errors.push("Repository provider evidence lacks a bound snapshot.");
      }
      continue;
    }
    errors.push(...providerBindingErrors(dataset, repository, snapshot));
  }
  for (const repositoryId of requiredRepositories) {
    if (!snapshotMap.has(repositoryId)) errors.push("Required repository lacks a provider snapshot.");
  }
  return errors;
}

function providerBindingErrors(dataset, repository, snapshot) {
  const errors = validateProviderSnapshot(snapshot, {
    repository: repository.canonicalRepositoryId,
    headCommit: repository.headCommit,
    observedAt: dataset.observedAt,
  }).map(() => "Provider snapshot does not bind the dataset repository.");
  for (const system of PROVIDER_SYSTEMS) {
    errors.push(...sourceBindingErrors(repository, snapshot, system));
  }
  const expectedChanges = snapshot.deliveryChanges.map((change) => ({
    ...structuredClone(change),
    releasedAt: null,
  })).sort(compareIds);
  const actualChanges = structuredClone(repository.deliveryChanges).sort(compareIds);
  if (canonicalJson(actualChanges) !== canonicalJson(expectedChanges)) {
    errors.push("Dataset delivery traces do not match the provider snapshot.");
  }
  if (snapshot.deliveryChanges.some((change) =>
    change.validationStatus !== "unavailable"
  ) && !availableSource(repository, "tabellio-validation")) {
    errors.push("Exact validation status lacks validation evidence.");
  }
  return errors;
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
  if (profile === "schema") {
    return [{ name: "analytics_validator_schema_pass", value: pass, unit: "boolean" }, ...common];
  }
  if (profile === "semantic") {
    return [
      { name: "analytics_validator_semantic_pass", value: pass, unit: "boolean" },
      { name: "analytics_repository_count", value: result.repositoryCount, unit: "count" },
      { name: "analytics_trace_count", value: result.traceCount, unit: "count" },
      ...common,
    ];
  }
  if (profile === "workflow") {
    return [
      { name: "analytics_validator_workflow_pass", value: pass, unit: "boolean" },
      { name: "analytics_snapshot_count", value: result.snapshotCount, unit: "count" },
      ...common,
    ];
  }
  if (profile === "operational") {
    return [
      {
        name: "analytics_projection_25x_duration_ms",
        value: result.projectionDurationMs ?? 0,
        unit: "milliseconds",
      },
      ...common,
    ];
  }
  return [{ name: "analytics_validator_security_pass", value: pass, unit: "boolean" }, ...common];
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
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      strings.push(key);
      visit(entry, strings);
    }
  }
}

function sensitiveEvidence(value) {
  if (hasCredentialShape(value)) return true;
  if (/(?:api[_-]?key|authorization|access[_-]?token|client[_-]?secret|private[_-]?key|password|token|secret)\s*[=:]/i.test(value)) {
    return true;
  }
  if (/file:/i.test(value) || /(?:^|[\s=:(])~(?:\/|$)/.test(value)) return true;
  if (/(?:^|[\s=:(\['"`])\.\.?[\\/]\S*/.test(value)) return true;
  if (/(?:^|[^A-Za-z0-9/])\/(?:Users|private|tmp|home|var|etc)\//i.test(value)) return true;
  if (/(?:^|[^A-Za-z0-9+.-])[A-Za-z]:[\\/]+\S+/.test(value)) return true;
  return /(?:^|[^\\])\\\\[^\\\s]+\\/.test(value);
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
  const outputState = await pathState(outputPath);
  if (outputState?.symbolicLink) throw new Error("Validator output must not be a symbolic link.");
  const outputCandidate = await canonicalCandidatePath(outputPath, outputState);
  for (const input of protectedInputs) {
    const inputState = await pathState(input);
    const inputCandidate = await canonicalCandidatePath(input, inputState);
    if (outputCandidate === inputCandidate || sameFile(outputState, inputState)) {
      throw new Error("Validator output must not alias an input.");
    }
  }
  return outputPath;
}
