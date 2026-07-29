import { validateAnalyticsDataset } from "./analytics.mjs";

export function renderAnalyticsBaselineReport(dataset) {
  validateAnalyticsDataset(dataset);
  return `${[
    `# ${markdownText(dataset.id)}`,
    "",
    `Observed: ${dataset.observedAt}`,
    `Window: ${dataset.window.since} to ${dataset.window.until}`,
    `Dataset digest: \`${dataset.integrity.digest}\``,
    "",
    "## Interpretation boundary",
    "",
    "Repository rows describe evidence coverage and delivery-system behavior. They do not rank developers or infer user value from activity volume.",
    "",
    "## Repository baseline",
    "",
    "| Repository | Head | Changes | Traceability | Lead time | Cycle time | CI disagreement | Release lag |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...dataset.repositories.map(repositoryRow),
    "",
    ...deliveryTrace(dataset.repositories),
    "",
    "## Missing evidence",
    "",
    ...dataset.repositories.flatMap(missingEvidence),
    "## Metric definitions",
    "",
    ...dataset.metricDefinitions.map(metricDefinition),
    "",
    "## Provenance",
    "",
    ...dataset.repositories.flatMap(repositoryProvenance),
  ].join("\n").trimEnd()}\n`;
}

function repositoryRow(repository) {
  const metrics = repository.metrics;
  return [
    `| ${markdownText(repository.canonicalRepositoryId)}`,
    `\`${repository.headCommit.slice(0, 12)}\``,
    displayMetric(metrics.deliveryChangeCount),
    displayMetric(metrics.taskToPrTraceability),
    displayMetric(metrics.leadTimeHours),
    displayMetric(metrics.cycleTimeHours),
    displayMetric(metrics.ciDisagreementRate),
    displayMetric(metrics.releaseLagHours),
  ].join(" | ") + " |";
}

function displayMetric(metric) {
  if (metric.status !== "measured") return "unknown";
  if (metric.unit === "ratio") return `${(metric.value * 100).toFixed(1)}%`;
  if (metric.unit === "hours") return `${metric.value.toFixed(2)} h`;
  return String(metric.value);
}

function deliveryTrace(repositories) {
  const changes = repositories.flatMap((repository) =>
    repository.deliveryChanges.map((change) => ({
      repository: repository.canonicalRepositoryId,
      ...change,
    })));
  if (changes.length === 0) {
    return [
      "## Delivery change trace",
      "",
      "No sanitized provider changes supplied; linked delivery metrics remain unknown.",
    ];
  }
  return [
    "## Delivery change trace",
    "",
    "| Repository | Change | Plane | PR | Head | Exact validation | Hosted CI | Merged | Released |",
    "| --- | --- | --- | ---: | --- | --- | --- | --- | --- |",
    ...changes.map(deliveryChangeRow),
  ];
}

function deliveryChangeRow(change) {
  return [
    `| ${markdownText(change.repository)}`,
    markdownText(change.id),
    markdownText(fallback(change.planeStoryId)),
    markdownText(fallback(change.pullRequestNumber)),
    `\`${change.headCommit.slice(0, 12)}\``,
    markdownText(change.validationStatus),
    markdownText(change.hostedStatus),
    markdownText(fallback(change.mergedAt)),
    markdownText(fallback(change.releasedAt)),
  ].join(" | ") + " |";
}

function fallback(value) {
  return value ?? "unknown";
}

function missingEvidence(repository) {
  const missing = repository.sources.filter(
    (source) => source.status !== "available",
  );
  const lines = missing.length
    ? missing.map((source) =>
      `- ${markdownText(source.system)}: ${markdownText(source.status)} — ${markdownText(source.reason)}`)
    : ["None."];
  return [
    `### ${markdownText(repository.canonicalRepositoryId)}`,
    "",
    ...lines,
    "",
  ];
}

function metricDefinition(definition) {
  return `- \`${definition.id}\` (${definition.unit})`;
}

function repositoryProvenance(repository) {
  return [
    `### ${markdownText(repository.canonicalRepositoryId)}`,
    "",
    `- HEAD: \`${repository.headCommit}\` at ${repository.headCommittedAt}`,
    ...repository.sources.map((source) =>
      `- ${markdownText(source.system)}: ${markdownText(source.status)}; version ${markdownText(source.sourceVersion ?? "unknown")}; digest ${markdownText(source.contentDigest ?? "unavailable")}`),
    "",
  ];
}

function markdownText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\|`*_[\]{}!])/g, "\\$1");
}
