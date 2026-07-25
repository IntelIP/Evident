export function extractDeploymentReceipts(input) {
  if (Array.isArray(input)) return input;
  if (input?.status === "available" && input.receipt) return [input.receipt];
  if (input?.schemaVersion === "tabellio-deployment-receipt/v0.1") return [input];
  throw new Error("--deployments must contain deployment receipts or a collector result.");
}
