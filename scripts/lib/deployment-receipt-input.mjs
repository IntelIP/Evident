export function extractDeploymentReceipts(input) {
  if (Array.isArray(input)) return { receipts: input, blockedReason: null };
  if (input?.status === "available" && input.receipt) return { receipts: [input.receipt], blockedReason: null };
  if (input?.status === "blocked" && typeof input.reason === "string" && input.receipt === null) return { receipts: [], blockedReason: input.reason };
  if (input?.schemaVersion === "tabellio-deployment-receipt/v0.1") return { receipts: [input], blockedReason: null };
  throw new Error("--deployments must contain deployment receipts or a collector result.");
}
