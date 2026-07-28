import { isSafeProviderVersion } from "./portable-evidence.mjs";

export function extractDeploymentReceipts(input) {
  if (Array.isArray(input)) return { receipts: input, blockedReason: null };
  return extractObjectInput(input);
}

function extractObjectInput(input) {
  if (isAvailableResult(input)) return { receipts: [input.receipt], blockedReason: null };
  if (isBlockedResult(input)) return { receipts: [], blockedReason: input.reason };
  if (isReceipt(input)) return { receipts: [input], blockedReason: null };
  throw new Error("--deployments must contain deployment receipts or a collector result.");
}

function isAvailableResult(input) {
  if (Object(input).status !== "available") return false;
  return Boolean(Object(input).receipt);
}

function isBlockedResult(input) {
  if (Object(input).status !== "blocked") return false;
  if (Object(input).receipt !== null) return false;
  if (typeof Object(input).reason !== "string") return false;
  return isSafeProviderVersion(input.reason);
}

function isReceipt(input) {
  return Object(input).schemaVersion === "tabellio-deployment-receipt/v0.1";
}
