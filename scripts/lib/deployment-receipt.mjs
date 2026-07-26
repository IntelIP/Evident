import { readFileSync } from "node:fs";

import { isJsonDateTime, validateJsonSchema } from "./json-schema-validator.mjs";

const SCHEMA_VERSION = "tabellio-deployment-receipt/v0.1";
const SCHEMA = JSON.parse(readFileSync(
  new URL("../../schemas/deployment-receipt.v0.1.schema.json", import.meta.url),
  "utf8",
));
const CREDENTIAL_SHAPE = /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+|\bbearer\s+\S+|\b(?:token|secret|password|authorization)\s*[=:]|:\/\/[^/\s:@]+:[^/\s@]+@/i;
const LOCAL_PATH_SHAPE = /(?:\bfile:\/{2,}|(?:^|[^A-Za-z0-9])(?:\/(?:Users|home|tmp|private|workspace)\/|[A-Za-z]:\\Users\\))/i;

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
  for (const value of Object.values(receipt).filter((item) => typeof item === "string")) {
    if (CREDENTIAL_SHAPE.test(value) || LOCAL_PATH_SHAPE.test(value)) throw new Error("Deployment receipt contains unsafe portable provenance.");
  }
  return receipt;
}
