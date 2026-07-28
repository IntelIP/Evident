import { contract } from "./contract-checks.mjs";
import {
  canonicalRepositoryId,
  hasCredentialShape,
} from "./portable-evidence.mjs";
import { isStrictDateTime } from "./strict-date-time.mjs";

const VERSION = "tabellio-deployment-receipt/v0.1";
const FIELDS = [
  "schemaVersion",
  "id",
  "repository",
  "environment",
  "commit",
  "status",
  "deployedAt",
  "observedAt",
  "provider",
  "externalId",
  "releaseTag",
  "provenancePointer",
];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/;
const SAFE_POINTER = /^[A-Za-z][A-Za-z0-9+.-]{0,31}:[A-Za-z0-9/][A-Za-z0-9._:/?&=-]{0,467}$/;
const PROVIDERS = ["cloud-run", "vercel"];
const STATUSES = ["passed", "failed", "blocked"];
const CREDENTIAL_ASSIGNMENT = /\b(?:bearer\s+\S+|token|secret|password|authorization)\s*[=:]?/i;
const LOCAL_PATH = /(?:\bfile:|(?:^|[\s=:(])~\/|(?:^|[\s=:(\['"`])\.?\.?\/|[A-Za-z]:[\\/])/i;

export function validateDeploymentReceipt(receipt) {
  contract.object(receipt, "Deployment receipt");
  contract.exactKeys(receipt, FIELDS, "Deployment receipt");
  contract.equals(receipt.schemaVersion, VERSION, "Deployment receipt schemaVersion");
  assertIdentifiers(receipt);
  assertStatusAndProvider(receipt);
  assertOptional(receipt.releaseTag, SAFE_TAG, "releaseTag");
  assertOptional(receipt.provenancePointer, SAFE_POINTER, "provenancePointer");
  assertReceiptTimes(receipt);
  FIELDS.map((field) => receipt[field])
    .filter(isString)
    .forEach(assertSafeString);
  return receipt;
}

function assertIdentifiers(receipt) {
  ensure(SAFE_ID.test(String(receipt.id)) && receipt.id.length <= 128, "Deployment receipt id is invalid.");
  ensure(canonicalRepositoryId(receipt.repository) !== null, "Deployment receipt repository is invalid.");
  ensure(SAFE_ENVIRONMENT.test(String(receipt.environment)), "Deployment receipt environment is invalid.");
  contract.oid(receipt.commit, "Deployment receipt commit");
  ensure(SAFE_ID.test(String(receipt.externalId)), "Deployment receipt externalId is invalid.");
}

function assertStatusAndProvider(receipt) {
  contract.member(receipt.status, STATUSES, "Deployment receipt status");
  contract.member(receipt.provider, PROVIDERS, "Deployment receipt provider");
}

function assertReceiptTimes(receipt) {
  assertDateTime(receipt.observedAt, "observedAt");
  if (receipt.deployedAt !== null) assertDateTime(receipt.deployedAt, "deployedAt");
  ensure(receipt.status !== "passed" || receipt.deployedAt !== null, "Passed deployment receipt requires deployedAt.");
  if (receipt.deployedAt === null) return;
  ensure(Date.parse(receipt.deployedAt) <= Date.parse(receipt.observedAt), "Deployment receipt deployedAt cannot be after observedAt.");
}

function isString(value) {
  return typeof value === "string";
}

function assertSafeString(value) {
  ensure(!hasCredentialShape(value), "Deployment receipt contains unsafe portable provenance.");
  ensure(!CREDENTIAL_ASSIGNMENT.test(value), "Deployment receipt contains unsafe portable provenance.");
  ensure(!LOCAL_PATH.test(value), "Deployment receipt contains unsafe portable provenance.");
}

function assertOptional(value, pattern, label) {
  if (value === null) return;
  ensure(typeof value === "string" && pattern.test(value), `Deployment receipt ${label} is invalid.`);
}

function assertDateTime(value, label) {
  ensure(isStrictDateTime(value), `Deployment receipt ${label} is invalid.`);
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
