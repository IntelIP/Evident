import { createHash } from "node:crypto";
import { canonicalDateTime } from "./strict-date-time.mjs";
import { hasCredentialShape } from "./portable-evidence.mjs";

const MAX_TEXT_LENGTH = 512;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PAYLOAD_DEPTH = 8;
const MAX_PAYLOAD_NODES = 512;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const STATUSES = new Set(["present", "missing", "stale", "conflicting", "inferred", "blocked", "failed", "passed"]);
const SENSITIVITIES = new Set(["public", "internal", "private"]);
const SENSITIVE_VALUE_PATTERNS = [
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|client[_-]?secret|private[_-]?key|password|passwd|cookie|secret|token)\s*[=:]\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];
const FORBIDDEN_PAYLOAD_KEYS = /(?:password|passwd|secret|api_key|access_token|refresh_token|authorization|cookie|private_key|transcript|raw(?:_|$)|code_snapshot|process_env|^environment(?:_|$)|^env(?:_|$)|(?:^|_)prompt(?:_|$)|(?:^|_)tool(?:_|$)|^mcp(?:_|$)|^provider_(?:request|response|body)(?:_|$)|(?:^|_)token$)/;
const APPROVED_PAYLOAD_KEYS = new Set([
  "a", "z", "refs", "note", "summary", "title", "description", "labels", "links", "metadata",
  "kind", "reason", "value", "count", "state", "status", "source", "source_id", "entity_type", "entity_key",
  "project_key", "repository_id", "run_id", "commit_sha", "checkpoint_id", "pull_request_number", "validation_id",
  "observed_at",
]);

export function normalizeRecord(record) {
  if (!isPlainObject(record)) throw new TypeError("record must be an object.");
  const payload = record.payload ?? {};
  if (!isPlainObject(payload)) throw new TypeError("record.payload must be an object.");
  const payloadState = { nodes: 0, hasCheckpointReference: false };
  const payloadJson = canonicalJson(payload, "$", payloadState);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error(`record.payload must be at most ${MAX_PAYLOAD_BYTES} bytes.`);
  }
  const source = boundedText(record.source, "source");
  const sourceId = boundedText(record.sourceId, "sourceId");
  const checkpointId = optionalCheckpointId(record.checkpointId);
  const sensitivity = enumValue(record.sensitivity ?? "internal", SENSITIVITIES, "sensitivity");
  const normalizedFields = {
    recordId: boundedText(record.recordId ?? defaultRecordId(source, sourceId), "recordId"),
    entityType: boundedText(record.entityType, "entityType"),
    entityKey: boundedText(record.entityKey, "entityKey"),
    projectKey: optionalBoundedText(record.projectKey, "projectKey"),
    repositoryId: optionalBoundedText(record.repositoryId, "repositoryId"),
    runId: optionalBoundedText(record.runId, "runId"),
    commitSha: optionalHex(record.commitSha, "commitSha", [40, 64]),
    checkpointId,
    pullRequestNumber: optionalPositiveInteger(record.pullRequestNumber, "pullRequestNumber"),
    validationId: optionalBoundedText(record.validationId, "validationId"),
    source,
    sourceId,
    observedAt: normalizedDate(record.observedAt),
    status: enumValue(record.status ?? "present", STATUSES, "status"),
    sensitivity,
  };
  const metadataHasCheckpointReference = Object.values(normalizedFields)
    .some((value) => typeof value === "string" && containsCheckpointReference(value));
  if (checkpointId !== null && sensitivity !== "private") {
    throw new Error("checkpointId requires private sensitivity.");
  }
  if ((payloadState.hasCheckpointReference || metadataHasCheckpointReference) && sensitivity !== "private") {
    throw new Error("payload checkpoint reference requires private sensitivity.");
  }
  return {
    ...normalizedFields,
    payload,
    payloadJson,
    payloadSha256: createHash("sha256").update(payloadJson).digest("hex"),
  };
}

function canonicalJson(value, path = "$", state = { nodes: 0, hasCheckpointReference: false }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_PAYLOAD_NODES) throw new Error(`record.payload exceeds ${MAX_PAYLOAD_NODES} values.`);
  if (value === null) return "null";
  if (typeof value === "string") {
    validatePayloadText(value, path);
    if (containsCheckpointReference(value)) state.hasCheckpointReference = true;
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must not contain a non-finite number.`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_PAYLOAD_DEPTH) throw new Error(`record.payload exceeds depth ${MAX_PAYLOAD_DEPTH}.`);
    return `[${value.map((item, index) => canonicalJson(item, `${path}[${index}]`, state, depth + 1)).join(",")}]`;
  }
  if (!isPlainObject(value)) throw new Error(`${path} must contain only JSON values.`);
  if (depth >= MAX_PAYLOAD_DEPTH) throw new Error(`record.payload exceeds depth ${MAX_PAYLOAD_DEPTH}.`);
  return canonicalObject(value, path, state, depth);
}

function validatePayloadText(value, path) {
  if (hasUnsupportedPostgresText(value)) throw new Error(`record.payload contains unsupported PostgreSQL text at ${path}.`);
  if (containsSensitiveText(value)) throw new Error(`record.payload contains a sensitive value at ${path}.`);
}

function canonicalObject(value, path, state, depth) {
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => canonicalField(key, value, path, state, depth)).join(",")}}`;
}

function canonicalField(key, value, path, state, depth) {
    const normalizedKey = key
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .toLowerCase();
    if (normalizedKey === "checkpoint_id") {
      state.hasCheckpointReference = true;
      if (optionalCheckpointId(value[key]) === null) {
        throw new Error(`record.payload checkpoint reference at ${path}.${key} must be a valid ID.`);
      }
    }
    if (FORBIDDEN_PAYLOAD_KEYS.test(normalizedKey)) throw new Error(`record.payload contains a forbidden field at ${path}.${key}.`);
    if (!APPROVED_PAYLOAD_KEYS.has(normalizedKey)) throw new Error(`record.payload contains an unapproved field at ${path}.${key}.`);
    return `${JSON.stringify(key)}:${canonicalJson(value[key], `${path}.${key}`, state, depth + 1)}`;
}

function normalizedDate(value) {
  const text = requiredString(value, "observedAt");
  const parsed = canonicalDateTime(text);
  if (parsed === null) throw new Error("observedAt must be a strict ISO 8601 date-time.");
  return parsed;
}

function optionalHex(value, path, lengths) {
  if (value === undefined || value === null) return null;
  const text = requiredString(value, path).toLowerCase();
  if (!lengths.includes(text.length) || !/^[0-9a-f]+$/.test(text)) {
    throw new Error(`${path} must be hexadecimal with length ${lengths.join(" or ")}.`);
  }
  return text;
}

function optionalCheckpointId(value) {
  if (value === undefined || value === null) return null;
  const text = requiredString(value, "checkpointId");
  if (/^[0-9a-f]{12}$/i.test(text)) return text.toLowerCase();
  const ulid = text.toUpperCase();
  if (/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(ulid)) return ulid;
  throw new Error("checkpointId must be a 12-character hexadecimal ID or 26-character Crockford ULID.");
}

function optionalPositiveInteger(value, path) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_POSTGRES_INTEGER) {
    throw new Error(`${path} must be a positive PostgreSQL integer.`);
  }
  return value;
}

function enumValue(value, allowed, path) {
  const text = requiredString(value, path);
  if (!allowed.has(text)) throw new Error(`${path} must be one of: ${[...allowed].join(", ")}.`);
  return text;
}

export function boundedText(value, path) {
  const text = requiredString(value, path);
  if (text.length > MAX_TEXT_LENGTH) throw new Error(`${path} must be at most ${MAX_TEXT_LENGTH} characters.`);
  if (containsSensitiveText(text)) throw new Error(`${path} contains a sensitive value.`);
  return text;
}

function optionalBoundedText(value, path) {
  if (value === undefined || value === null) return null;
  return boundedText(value, path);
}

export function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be a non-empty string.`);
  if (hasUnsupportedPostgresText(value)) throw new Error(`${path} contains unsupported PostgreSQL text.`);
  return value.trim();
}

function containsSensitiveText(value) {
  return hasCredentialShape(value) || SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function containsCheckpointReference(value) {
  if (typeof value !== "string") return false;
  return /(?:^|[^0-9a-f])(?:[0-9a-f]{12}|[0-7][0-9A-HJKMNP-TV-Z]{25})(?![0-9a-f])/i.test(value);
}

function hasUnsupportedPostgresText(value) {
  if (value.includes("\u0000")) return true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function defaultRecordId(source, sourceId) {
  return `record-${createHash("sha256").update(`${String(source ?? "")}\0${String(sourceId ?? "")}`).digest("hex")}`;
}
