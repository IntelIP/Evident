import { validateDeliveryEvidenceSnapshot } from "./delivery-evidence-joiner.mjs";

export function renderDeliveryReport(snapshot, { cadence = "daily" } = {}) {
  validateDeliveryEvidenceSnapshot(snapshot);
  if (!["daily", "weekly", "monthly"].includes(cadence)) throw new Error("Report cadence must be daily, weekly, or monthly.");
  const records = snapshot.deliveryRecords;
  const shipped = records.filter((record) => record.release.status === "shipped");
  const deployed = records.filter((record) => record.deployment.status === "passed");
  const ciPassed = records.filter((record) => record.ci.status === "passed");
  const active = snapshot.wipByProject.filter((project) => project.activeItemCount > 0);
  const overLimit = snapshot.wipByProject.filter((project) => project.overLimit);
  const aging = snapshot.wipByProject.filter((project) => project.aging3dCount > 0);
  return [
    `# ${title(cadence)} delivery check-in`, "",
    `Captured: ${snapshot.capturedAt}`, `Repository evidence: ${snapshot.repository}`, "",
    "## Shipping", "",
    `- Shipped (published GitHub Release): ${shipped.length}/${records.length}`,
    `- Deployed with exact runtime receipt: ${deployed.length}/${records.length}`,
    `- Exact-head Buildkite passed: ${ciPassed.length}/${records.length}`,
    "",
    "## Portfolio WIP", "",
    ...(active.length ? active.map((project) => `- ${project.project}: ${project.activeItemCount} active${project.overLimit ? " — over limit" : ""}${project.aging3dCount ? `; ${project.aging3dCount} aged 3+ days` : ""}`) : ["- No active Plane items observed."]),
    "", "## Evidence gaps", "",
    ...gaps(snapshot, records), "",
    "## Delivery records", "",
    ...(records.length ? records.map(recordLine) : ["- No explicitly joined delivery records."]),
    "", "## Decision", "",
    decision({ shipped, deployed, ciPassed, records, overLimit, aging }), "",
  ].join("\n");
}
function title(cadence) { return cadence[0].toUpperCase() + cadence.slice(1); }
function gaps(snapshot, records) { const result=[]; for (const [name, source] of Object.entries(snapshot.sources)) if (source.status !== "available") result.push(`- ${name}: ${source.status} — ${markdownText(source.reason)}`); if (records.some((record) => record.linkBasis === "unlinked" || record.plane.status !== "linked")) result.push("- Some delivery records lack an explicit Plane-to-PR relationship."); if (records.some((record) => record.ci.status !== "passed")) result.push("- Some delivery records lack passed exact-head Buildkite evidence."); if (records.some((record) => record.release.status !== "shipped")) result.push("- Some explicit delivery records have no GitHub Release proven on the exact commit."); if (records.some((record) => record.deployment.status !== "passed")) result.push("- Deployment runtime proof is missing or not passed for some records; this does not change GitHub Release shipping truth."); return result.length ? result : ["- None."]; }
function recordLine(record) { return `- ${markdownText(record.id)}: Plane ${record.plane.status}; CI ${record.ci.status}; release ${record.release.status}; deployment ${record.deployment.status}.`; }
function decision({ shipped, deployed, ciPassed, records, overLimit, aging }) { if (!records.length) return "No decision-grade delivery records yet. Add explicit Plane-to-PR links."; if (records.some((record) => record.linkBasis === "unlinked" || record.plane.status !== "linked")) return "Do not claim complete shipping health; link every delivery record to Plane and its pull request."; if (overLimit.length || aging.length) return "Portfolio attention: reduce WIP or resolve aging work before adding parallel work."; if (shipped.length === records.length && ciPassed.length === records.length) return deployed.length === records.length ? "Shipping path healthy." : "Shipping proven. Runtime deployment evidence remains incomplete."; return "Do not claim complete shipping health; resolve the listed exact-evidence gaps."; }
function markdownText(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/([\\|`*_[\]{}!])/g, "\\$1"); }
