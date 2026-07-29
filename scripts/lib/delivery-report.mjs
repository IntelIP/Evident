import {
  validateDeliveryEvidenceSnapshot,
} from "./delivery-evidence-joiner.mjs";

const CADENCES = new Set(["daily", "weekly", "monthly"]);

export function renderDeliveryReport(snapshot, { cadence = "daily" } = {}) {
  validateDeliveryEvidenceSnapshot(snapshot);
  if (!CADENCES.has(cadence)) {
    throw new Error("Report cadence must be daily, weekly, or monthly.");
  }
  const records = snapshot.deliveryRecords;
  const shipped = records.filter((record) => record.release.status === "shipped");
  const deployed = records.filter(
    (record) => record.deployment.status === "passed",
  );
  const ciPassed = records.filter((record) => record.ci.status === "passed");
  const active = snapshot.wipByProject.filter(
    (project) => project.activeItemCount > 0,
  );
  const overLimit = snapshot.wipByProject.filter((project) => project.overLimit);
  const aging = snapshot.wipByProject.filter(
    (project) => project.aging3dCount > 0,
  );
  return [
    `# ${title(cadence)} delivery check-in`,
    "",
    `Captured: ${snapshot.capturedAt}`,
    `Repository evidence: ${snapshot.repository}`,
    "",
    "## Shipping",
    "",
    `- Shipped (published GitHub Release): ${shipped.length}/${records.length}`,
    `- Deployed with exact runtime receipt: ${deployed.length}/${records.length}`,
    `- Exact-head Buildkite passed: ${ciPassed.length}/${records.length}`,
    "",
    "## Portfolio WIP",
    "",
    ...portfolioLines(active),
    "",
    "## Evidence gaps",
    "",
    ...evidenceGaps(snapshot, records),
    "",
    "## Delivery records",
    "",
    ...recordLines(records),
    "",
    "## Decision",
    "",
    deliveryDecision({
      shipped,
      deployed,
      ciPassed,
      records,
      overLimit,
      aging,
    }),
    "",
  ].join("\n");
}

function title(cadence) {
  return cadence[0].toUpperCase() + cadence.slice(1);
}

function portfolioLines(active) {
  if (active.length === 0) return ["- No active Plane items observed."];
  return active.map((project) => {
    const limit = project.overLimit ? " — over limit" : "";
    const aging = project.aging3dCount
      ? `; ${project.aging3dCount} aged 3+ days`
      : "";
    return `- ${project.project}: ${project.activeItemCount} active${limit}${aging}`;
  });
}

function evidenceGaps(snapshot, records) {
  const result = [
    ...sourceGaps(snapshot.sources),
    gapWhen(
      records.some(isUnlinked),
      "- Some delivery records lack an explicit Plane-to-PR relationship.",
    ),
    gapWhen(
      records.some((record) => record.ci.status !== "passed"),
      "- Some delivery records lack passed exact-head Buildkite evidence.",
    ),
    gapWhen(
      records.some((record) => record.release.status !== "shipped"),
      "- Some explicit delivery records have no GitHub Release proven on the exact commit.",
    ),
    gapWhen(
      records.some((record) => record.deployment.status !== "passed"),
      "- Deployment runtime proof is missing or not passed for some records; this does not change GitHub Release shipping truth.",
    ),
  ].filter(Boolean);
  return result.length ? result : ["- None."];
}

function gapWhen(condition, message) {
  return condition ? message : null;
}

function sourceGaps(sources) {
  return Object.entries(sources)
    .filter(([, source]) => source.status !== "available")
    .map(([name, source]) =>
      `- ${name}: ${source.status} — ${markdownText(source.reason)}`);
}

function isUnlinked(record) {
  if (record.linkBasis === "unlinked") return true;
  return record.plane.status !== "linked";
}

function recordLines(records) {
  if (records.length === 0) {
    return ["- No explicitly joined delivery records."];
  }
  return records.map((record) =>
    `- ${markdownText(record.id)}: Plane ${record.plane.status}; CI ${record.ci.status}; release ${record.release.status}; deployment ${record.deployment.status}.`);
}

function deliveryDecision({
  shipped,
  deployed,
  ciPassed,
  records,
  overLimit,
  aging,
}) {
  const context = {
    shipped,
    deployed,
    ciPassed,
    records,
    overLimit,
    aging,
  };
  for (const rule of DECISION_RULES) {
    const result = rule(context);
    if (result !== null) return result;
  }
  return deployed.length === records.length
    ? "Shipping path healthy."
    : "Shipping proven. Runtime deployment evidence remains incomplete.";
}

const DECISION_RULES = [
  noRecordsDecision,
  unlinkedDecision,
  portfolioDecision,
  incompleteEvidenceDecision,
];

function noRecordsDecision({ records }) {
  if (records.length === 0) {
    return "No decision-grade delivery records yet. Add explicit Plane-to-PR links.";
  }
  return null;
}

function unlinkedDecision({ records }) {
  if (records.some(isUnlinked)) {
    return "Do not claim complete shipping health; link every delivery record to Plane and its pull request.";
  }
  return null;
}

function portfolioDecision({ overLimit, aging }) {
  if (overLimit.length > 0) {
    return "Portfolio attention: reduce WIP or resolve aging work before adding parallel work.";
  }
  if (aging.length > 0) {
    return "Portfolio attention: reduce WIP or resolve aging work before adding parallel work.";
  }
  return null;
}

function incompleteEvidenceDecision({ shipped, ciPassed, records }) {
  if (shipped.length !== records.length) {
    return "Do not claim complete shipping health; resolve the listed exact-evidence gaps.";
  }
  if (ciPassed.length !== records.length) {
    return "Do not claim complete shipping health; resolve the listed exact-evidence gaps.";
  }
  return null;
}

function markdownText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\|`*_[\]{}!])/g, "\\$1");
}
