import { assembleLineage, evaluateLineage } from "./provenance-ledger.mjs";
import { attachSecurityReview } from "./provenance-security.mjs";
import { parseGitHubRepositoryRemote } from "./github-repository.mjs";
import { normalizeRecord } from "./provenance-record.mjs";

const STATES = { passed: "success", failed: "failure", blocked: "error" };
const ACTIONS = {
  security: "Inspect the security receipt, resolve its findings, and rerun security checks for this candidate.",
  review: "Address the review findings and obtain a review of this exact candidate.",
  validation: "Inspect failed CI evidence, fix the failing checks, and rerun validation for this candidate.",
};

function repository(candidate) {
  const id = candidate.repositoryId.replace(/^github\.com\//, "");
  return parseGitHubRepositoryRemote(`https://github.com/${id}`);
}

function sourceUrl(observation, repo) {
  if (observation.source === "buildkite") {
    const match = /^([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)\/([1-9][0-9]*)$/i.exec(observation.sourceId);
    return match ? `https://buildkite.com/${match[1]}/${match[2]}/builds/${match[3]}` : null;
  }
  if (!repo) return null;
  if (observation.source === "git" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(observation.sourceId)) return `https://github.com/${repo.fullName}/commit/${observation.sourceId}`;
  if (observation.kind === "pull_request") {
    const prefix = `${observation.candidate.repositoryId}#`;
    const number = observation.sourceId.startsWith(prefix) ? observation.sourceId.slice(prefix.length) : "";
    if (/^[1-9][0-9]*$/.test(number)) return `https://github.com/${repo.fullName}/pull/${number}`;
  }
  return null;
}

function reportLink(value) {
  if (value === null) return null;
  normalizeRecord({ entityType: "reference", entityKey: value, source: "tabellio", sourceId: "review-report", observedAt: "2026-01-01T00:00:00Z", sensitivity: "private" });
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) throw new Error("Report URL must be credential-free HTTPS or local HTTP without query parameters or fragments.");
  return url.toString();
}

function section(kind, reasons, evidence) {
  const status = reasons.some((item) => item.state === "failed") ? "failed" : reasons.length ? "blocked" : "passed";
  const actions = reasons.map((reason) => ({
    state: reason.state, kind: reason.kind,
    nextAction: reason.message === "Resolve source evidence before review readiness." ? ACTIONS[reason.kind] ?? reason.message : reason.message,
    evidence: evidence.find((item) => item.id === reason.evidenceId) ?? null,
  }));
  const nextAction = actions[0]?.nextAction ?? (kind === "security" ? "Security evidence passed for this candidate." : "Continue through the repository merge workflow for this candidate.");
  return { status, nextAction, actions };
}

function securityDetails(lineage, receipt, policyDigest, now, repo) {
  if (receipt === null) return { detailsState: "not_loaded", findings: [], checks: [] };
  const original = assembleLineage({ candidate: lineage.candidate, observations: lineage.observations.filter((item) => !(item.kind === "security" && item.sourceId === receipt.digest)) });
  const verified = attachSecurityReview({ lineage: original, review: receipt, policyDigest, now });
  if (verified.digest !== lineage.digest) throw new Error("Security receipt does not match this lineage.");
  const findings = receipt.checks.flatMap((check) => check.findings.map((item) => ({
    ...item,
    url: repo ? `https://github.com/${repo.fullName}/blob/${lineage.candidate.headCommit}/${item.path.split("/").map(encodeURIComponent).join("/")}#L${item.line}` : null,
  })));
  return { detailsState: "loaded", findings, checks: receipt.checks.map(({ category, status }) => ({ category, status })) };
}

export function buildProvenanceReviewResult(lineage, { candidate = lineage.candidate, now, reportUrl = null, securityReceipt = null, policyDigest } = {}) {
  const result = evaluateLineage(lineage, { candidate, now });
  const repo = repository(result.currentCandidate);
  const targetUrl = reportLink(reportUrl);
  const evidence = lineage.observations.filter((item) => item.candidate.id === result.currentCandidate.id).map((item) => ({
    id: item.id, kind: item.kind, source: item.source, sourceId: item.sourceId,
    lineageDigest: lineage.digest, url: sourceUrl(item, repo),
  }));
  const review = section("review", result.reasons.filter((item) => item.kind !== "security"), evidence);
  const security = section("security", result.reasons.filter((item) => ["security", "candidate"].includes(item.kind)), evidence);
  const details = result.currentCandidate.id === lineage.candidate.id
    ? securityDetails(lineage, securityReceipt, policyDigest, now, repo)
    : { detailsState: "stale", findings: [], checks: [] };
  // Each GitHub context uses the same verdict and full immutable candidate ID as
  // its CLI section. Presentation never turns missing evidence into a pass.
  const github = repo ? Object.entries({ review, security }).map(([kind, value]) => ({
    owner: repo.owner, repo: repo.name, commit: result.currentCandidate.headCommit,
    state: STATES[value.status], context: `Tabellio / provenance ${kind}`,
    description: `${value.status} ${result.currentCandidate.id}: ${value.nextAction}`.slice(0, 140),
    targetUrl: targetUrl ?? value.actions.find((item) => item.evidence?.url)?.evidence.url ?? null,
  })) : [];
  return { ...result, schemaVersion: "tabellio-review-result/v0.1", review, security: { ...security, ...details }, evidence, github };
}
