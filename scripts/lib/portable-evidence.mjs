const SOURCE_SYSTEMS = new Set(["plane", "github", "github-actions", "buildkite"]);
const SOURCE_STATES = new Set(["available", "unavailable", "blocked"]);
const CHANGE_FIELDS = new Set([
  "id",
  "linkBasis",
  "linkEvidence",
  "planeStoryId",
  "pullRequestNumber",
  "storyCreatedAt",
  "firstActivityAt",
  "mergedAt",
  "mergeCommit",
  "releasedAt",
  "releaseCommit",
  "headCommit",
  "validationStatus",
  "hostedStatus",
]);
const SOURCE_FIELDS = new Set(["status", "version", "reason"]);
const CREDENTIAL_PATTERNS = [
  /(?:^|[^a-z0-9])gh[pousr]_[a-z0-9_]{8,}/i,
  /(?:^|[^a-z0-9])github_pat_[a-z0-9_]{8,}/i,
  /(?:^|[^a-z0-9])sk-(?:live|proj)[_-][a-z0-9_-]{8,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /:\/\/[^/\s@]+@/,
];
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RELATIVE_PATH_PATTERN = /(?:^|[\s=:(\['"`])\.\.?\/\S*/;

export function hasCredentialShape(value) {
  return typeof value === "string" && CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

export function isPortableIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 200
    && !hasControlOrPath(value)
    && !hasCredentialShape(value)
    && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
    && !value.includes("//")
    && !value.includes("..")
    && !value.toLowerCase().startsWith("file:");
}

export function isSafeProviderText(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 500
    && !hasControlOrPath(value)
    && !hasCredentialShape(value)
    && !value.toLowerCase().includes("file:")
    && !RELATIVE_PATH_PATTERN.test(value);
}

export function isSafeProviderVersion(value) {
  return value === null || (isSafeProviderText(value) && value.length <= 200);
}

export function parseProviderVersionTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function canonicalRepositoryId(value) {
  if (typeof value !== "string" || hasCredentialShape(value) || !REPOSITORY_PATTERN.test(value)) return null;
  return value.toLowerCase();
}

export function sameRepository(left, right) {
  const leftId = canonicalRepositoryId(left);
  const rightId = canonicalRepositoryId(right);
  return leftId !== null && leftId === rightId;
}

export function validateEvidenceSource(source, { observedAt } = {}) {
  const errors = [];
  if (!isPlainObject(source)) return ["source must be an object"];
  rejectUnknownFields(source, SOURCE_FIELDS, "source", errors);
  if (!SOURCE_STATES.has(source.status)) errors.push("source status is invalid");
  if (!isSafeProviderVersion(source.version ?? null)) errors.push("source version is unsafe");
  if (source.status === "available" && (typeof source.version !== "string" || !isSafeProviderVersion(source.version))) {
    errors.push("available source requires a safe version");
  }
  if (source.status !== "available" && !isSafeProviderText(source.reason)) {
    errors.push("unavailable source requires a safe reason");
  }
  if (source.status !== "available" && source.version !== undefined && source.version !== null) {
    errors.push("unavailable source cannot carry a version");
  }
  if (source.status === "available" && Object.hasOwn(source, "reason")) {
    errors.push("available source cannot carry a reason");
  }
  const versionTimestamp = parseProviderVersionTimestamp(source.version);
  if (versionTimestamp !== null && isDateTime(observedAt) && versionTimestamp > Date.parse(observedAt)) {
    errors.push("source version is later than observation");
  }
  return unique(errors);
}

export function validateEvidenceBinding({ repository, headCommit, sourceRepository, sourceHeadCommit }) {
  const errors = [];
  if (!sameRepository(repository, sourceRepository)) errors.push("repository binding is invalid");
  if (!isCommit(headCommit) || !isCommit(sourceHeadCommit) || headCommit !== sourceHeadCommit) {
    errors.push("head binding is invalid");
  }
  return errors;
}

export function validateProviderSnapshot(snapshot, { repository, headCommit, observedAt } = {}) {
  const errors = [];
  if (!isPlainObject(snapshot)) return ["provider snapshot must be an object"];
  rejectUnknownFields(snapshot, new Set(["schemaVersion", "repository", "headCommit", "capturedAt", "sources", "deliveryChanges"]), "provider snapshot", errors);
  if (snapshot.schemaVersion !== "tabellio-analytics-provider-snapshot/v0.1") errors.push("provider snapshot schemaVersion is invalid");
  if (!sameRepository(repository, snapshot.repository)) errors.push("provider snapshot repository is invalid");
  if (!isCommit(snapshot.headCommit) || snapshot.headCommit !== headCommit) errors.push("provider snapshot headCommit does not bind the repository head");
  if (!isDateTime(snapshot.capturedAt)) errors.push("provider snapshot capturedAt is invalid");
  if (isDateTime(snapshot.capturedAt) && isDateTime(observedAt) && Date.parse(snapshot.capturedAt) > Date.parse(observedAt)) {
    errors.push("provider snapshot capture is later than observation");
  }
  const sources = snapshot.sources;
  if (!isPlainObject(sources)) {
    errors.push("provider snapshot sources are invalid");
  } else {
    for (const system of Object.keys(sources)) {
      if (!SOURCE_SYSTEMS.has(system)) errors.push(`provider source ${system} is not allowed`);
    }
    for (const system of SOURCE_SYSTEMS) {
      if (!Object.hasOwn(sources, system)) errors.push(`provider source ${system} is missing`);
      else errors.push(...prefix(system, validateEvidenceSource(sources[system], { observedAt: snapshot.capturedAt })));
    }
  }
  if (!Array.isArray(snapshot.deliveryChanges)) {
    errors.push("provider snapshot deliveryChanges are invalid");
  } else {
    const changeIds = new Set();
    const linkedRelationships = new Set();
    snapshot.deliveryChanges.forEach((change, index) => {
      errors.push(...prefix(`deliveryChanges[${index}]`, validateDeliveryChange(change, {
        sources,
        headCommit,
        capturedAt: snapshot.capturedAt,
      })));
      if (!isPlainObject(change)) return;
      if (isPortableIdentifier(change.id)) {
        if (changeIds.has(change.id)) errors.push(`deliveryChanges[${index}] duplicates delivery change id`);
        changeIds.add(change.id);
      }
      if (change.linkBasis !== "unlinked" && isPortableIdentifier(change.planeStoryId) && Number.isSafeInteger(change.pullRequestNumber)) {
        const relationship = `${change.planeStoryId}:${change.pullRequestNumber}`;
        if (linkedRelationships.has(relationship)) errors.push(`deliveryChanges[${index}] duplicates Plane and pull-request relationship`);
        linkedRelationships.add(relationship);
      }
    });
  }
  return unique(errors);
}

function validateDeliveryChange(change, { sources, headCommit, capturedAt }) {
  const errors = [];
  if (!isPlainObject(change)) return ["must be an object"];
  rejectUnknownFields(change, CHANGE_FIELDS, "delivery change", errors);
  if (!isPortableIdentifier(change.id)) errors.push("id is unsafe");
  if (!["explicit", "manual-reconciliation", "unlinked"].includes(change.linkBasis)) errors.push("linkBasis is invalid");
  if (change.linkEvidence !== null && !isSafeProviderText(change.linkEvidence)) errors.push("linkEvidence is unsafe");
  if (!isCommit(change.headCommit) || change.headCommit !== headCommit) errors.push("headCommit does not bind the repository head");
  if (!["passed", "failed", "blocked", "unavailable"].includes(change.validationStatus)) errors.push("validationStatus is invalid");
  if (!["passed", "failed", "blocked", "unavailable"].includes(change.hostedStatus)) errors.push("hostedStatus is invalid");
  const linked = change.linkBasis !== "unlinked";
  if (linked && (!isPortableIdentifier(change.planeStoryId) || !Number.isSafeInteger(change.pullRequestNumber) || change.pullRequestNumber < 1)) {
    errors.push("linked change requires Plane and pull-request identifiers");
  }
  if (!linked && (change.planeStoryId !== null || change.pullRequestNumber !== null || change.linkEvidence !== null)) {
    errors.push("unlinked change requires null relationship fields");
  }
  if (linked && !isAvailable(sources, "plane")) errors.push("linked change requires available Plane evidence");
  if (linked && !isAvailable(sources, "github")) errors.push("linked change requires available GitHub evidence");
  if (change.hostedStatus !== "unavailable" && !hasAvailableHostedSource(sources)) {
    errors.push("hosted status requires available hosted evidence");
  }
  if (change.storyCreatedAt !== null && !isAvailable(sources, "plane")) errors.push("storyCreatedAt requires available Plane evidence");
  if ((change.firstActivityAt !== null || change.mergedAt !== null) && !isAvailable(sources, "github")) {
    errors.push("GitHub lifecycle timestamps require available GitHub evidence");
  }
  const times = ["storyCreatedAt", "firstActivityAt", "mergedAt"];
  for (const field of times) {
    if (change[field] !== null && !isDateTime(change[field])) errors.push(`${field} is invalid`);
    if (isDateTime(change[field]) && isDateTime(capturedAt) && Date.parse(change[field]) > Date.parse(capturedAt)) {
      errors.push(`${field} is later than capture`);
    }
  }
  const lifecycleTimes = [
    ["storyCreatedAt", change.storyCreatedAt],
    ["firstActivityAt", change.firstActivityAt],
    ["mergedAt", change.mergedAt],
  ].filter(([, value]) => isDateTime(value));
  for (let index = 1; index < lifecycleTimes.length; index += 1) {
    const [previousName, previousValue] = lifecycleTimes[index - 1];
    const [currentName, currentValue] = lifecycleTimes[index];
    if (Date.parse(previousValue) > Date.parse(currentValue)) {
      errors.push(`${previousName} is later than ${currentName}`);
    }
  }
  if (change.mergeCommit !== undefined && change.mergeCommit !== null && !isCommit(change.mergeCommit)) {
    errors.push("mergeCommit is invalid");
  }
  if (change.mergeCommit !== undefined && change.mergeCommit !== null && !isDateTime(change.mergedAt)) {
    errors.push("mergeCommit requires mergedAt");
  }
  if (change.releasedAt !== undefined && change.releasedAt !== null) {
    if (!isDateTime(change.releasedAt)) errors.push("releasedAt is invalid");
    if (isDateTime(change.releasedAt) && Date.parse(change.releasedAt) > Date.parse(capturedAt)) {
      errors.push("releasedAt is later than capture");
    }
    if (isDateTime(change.mergedAt) && isDateTime(change.releasedAt)
      && Date.parse(change.releasedAt) < Date.parse(change.mergedAt)) {
      errors.push("mergedAt is later than releasedAt");
    }
    if (!isCommit(change.releaseCommit)) errors.push("releasedAt requires releaseCommit");
    if (!isCommit(change.mergeCommit)) errors.push("releasedAt requires mergeCommit");
  } else if (change.releaseCommit !== undefined && change.releaseCommit !== null) {
    errors.push("releaseCommit requires releasedAt");
  }
  return errors;
}

function isAvailable(sources, system) {
  return isPlainObject(sources) && sources[system]?.status === "available";
}

function hasAvailableHostedSource(sources) {
  return isAvailable(sources, "github-actions") || isAvailable(sources, "buildkite");
}

function isDateTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function isCommit(value) {
  return typeof value === "string" && COMMIT_PATTERN.test(value);
}

function hasControlOrPath(value) {
  return /[\u0000-\u001f\u007f-\u009f\u2028\u2029\\|]/.test(value)
    || /(?:^|[\s=:(\[\]'"`])\/(?!\/)\S*/.test(value)
    || /(?:^|[\s=:(])~(?:\/|$)/.test(value)
    || /(?:^|[^A-Za-z0-9._-])[A-Za-z]:\/(?:\S*)/.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownFields(value, fields, name, errors) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) errors.push(`${name} contains a field that is not allowed`);
  }
}

function prefix(name, errors) {
  return errors.map((error) => `${name}: ${error}`);
}

function unique(values) {
  return [...new Set(values)];
}
