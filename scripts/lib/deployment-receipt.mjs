import { readFileSync } from "node:fs";

import { isJsonDateTime, validateJsonSchema } from "./json-schema-validator.mjs";

const SCHEMA_VERSION = "tabellio-deployment-receipt/v0.1";
const SCHEMA = JSON.parse(readFileSync(
  new URL("../../schemas/deployment-receipt.v0.1.schema.json", import.meta.url),
  "utf8",
));

export function validateDeploymentReceipt(receipt) {
  const errors = validateJsonSchema(receipt, SCHEMA);
  if (errors.length > 0) throw new Error(`Invalid deployment receipt: ${errors.join("; ")}`);
  if (receipt.schemaVersion !== SCHEMA_VERSION) throw new Error("Invalid deployment receipt schemaVersion.");
  if (receipt.status === "passed" && !isJsonDateTime(receipt.deployedAt)) {
    throw new Error("Passed deployment receipt requires deployedAt.");
  }
  if (receipt.deployedAt && Date.parse(receipt.deployedAt) > Date.parse(receipt.observedAt)) {
    throw new Error("Deployment receipt deployedAt cannot be after observedAt.");
  }
  for (const value of [receipt.externalId, receipt.releaseTag, receipt.provenancePointer].filter((item) => item !== null)) {
    if (/\b(?:token|secret|password|authorization)\s*[=:]|:\/\/[^/\s:@]+:[^/\s@]+@|\b(?:file|https?):\/{2,}(?:Users|home|tmp|private|workspace)\//i.test(value)) throw new Error("Deployment receipt contains unsafe portable provenance.");
  }
  return receipt;
}
