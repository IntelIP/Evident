import { createHash } from "node:crypto";
import { assembleLineage, buildReviewPacket, candidateIdentity, verifyLineage } from "./provenance-ledger.mjs";
import { normalizeRecord } from "./provenance-record.mjs";

export const SECURITY_CHECKS = Object.freeze(["secrets", "authorization", "trust", "dependencies"]);
const HEX = /^[a-f0-9]{64}$/;
const STATES = new Set(["passed", "failed", "blocked"]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function requireFact(value) { if (!value) throw new Error("Invalid security evidence."); }

function safeText(value) {
  normalizeRecord({ entityType: "reference", entityKey: value, source: "tabellio", sourceId: "security", observedAt: "2026-01-01T00:00:00Z", sensitivity: "private" });
  return value;
}

function finding(input, category) {
  requireFact(input && SEVERITIES.has(input.severity) && HEX.test(input.evidenceDigest));
  requireFact(typeof input.ruleId === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(input.ruleId));
  requireFact(typeof input.path === "string" && !input.path.startsWith("/") && !input.path.includes("\\") && !input.path.split("/").some((part) => !part || part === "." || part === ".."));
  requireFact(Number.isSafeInteger(input.line) && input.line > 0 && input.line <= 2147483647);
  // Never copy messages, snippets, matched secrets, or raw scanner output.
  return { category, ruleId: safeText(input.ruleId), severity: input.severity, path: safeText(input.path), line: input.line, evidenceDigest: input.evidenceDigest };
}

function checkResult(input, category, binding) {
  requireFact(input && input.candidateId === binding.candidateId && input.packetDigest === binding.packetDigest && input.policyDigest === binding.policyDigest);
  requireFact(STATES.has(input.status) && Array.isArray(input.findings) && input.findings.length <= 64);
  const findings = input.findings.map((item) => finding(item, category)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // A scanner cannot override its own reported findings with a green label.
  const status = findings.length ? "failed" : input.status;
  return { category, status, findings };
}

export async function runSecurityReview({ lineage, candidate = lineage.candidate, now, policyDigest, checks, timeoutMs = 300000 }) {
  requireFact(typeof policyDigest === "string" && HEX.test(policyDigest));
  requireFact(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 900000);
  const packet = buildReviewPacket(lineage, { candidate, now });
  const binding = { candidateId: packet.candidate.id, packetDigest: packet.digest, policyDigest };
  const results = await Promise.all(SECURITY_CHECKS.map(async (category) => {
    const controller = new AbortController();
    let timer;
    try {
      requireFact(typeof checks?.[category] === "function");
      // Each check gets an isolated safe packet; one check cannot mutate another's input.
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Security check timed out.")); }, timeoutMs);
      });
      const input = await Promise.race([Promise.resolve().then(() => checks[category]({ packet: structuredClone(packet), ...binding, signal: controller.signal })), deadline]);
      return checkResult(input, category, binding);
    } catch {
      return { category, status: "blocked", findings: [] };
    } finally {
      clearTimeout(timer);
    }
  }));
  const status = results.some((item) => item.status === "failed") ? "failed" : results.every((item) => item.status === "passed") ? "passed" : "blocked";
  const result = { schemaVersion: "tabellio-security-review/v0.1", candidate: packet.candidate, packetDigest: packet.digest, policyDigest, observedAt: now, status, checks: results };
  // Reuse timestamp validation and ensure the review remains bounded.
  normalizeRecord({ entityType: "security", entityKey: packet.digest, source: "tabellio", sourceId: packet.digest, observedAt: now, sensitivity: "private" });
  requireFact(Buffer.byteLength(JSON.stringify(result)) <= 65536);
  return { ...result, digest: hash(result) };
}

export function attachSecurityReview({ lineage, review, policyDigest, now }) {
  verifyLineage(lineage);
  requireFact(review?.schemaVersion === "tabellio-security-review/v0.1" && HEX.test(policyDigest) && review.policyDigest === policyDigest);
  requireFact(candidateIdentity(review.candidate).id === lineage.candidate.id);
  const packet = buildReviewPacket(lineage, { now: review.observedAt });
  requireFact(review.packetDigest === packet.digest);
  requireFact(Array.isArray(review.checks) && review.checks.length === SECURITY_CHECKS.length);
  const binding = { candidateId: lineage.candidate.id, packetDigest: packet.digest, policyDigest };
  const checks = SECURITY_CHECKS.map((category, index) => {
    const input = review.checks[index];
    requireFact(input?.category === category);
    return checkResult({ ...input, ...binding }, category, binding);
  });
  const status = checks.some((item) => item.status === "failed") ? "failed" : checks.every((item) => item.status === "passed") ? "passed" : "blocked";
  const expected = { schemaVersion: review.schemaVersion, candidate: lineage.candidate, packetDigest: packet.digest, policyDigest, observedAt: review.observedAt, status, checks };
  requireFact(review.digest === hash(expected) && JSON.stringify(review) === JSON.stringify({ ...expected, digest: review.digest }));
  requireFact(Number.isFinite(Date.parse(now)) && Date.parse(review.observedAt) <= Date.parse(now));
  const validation = lineage.observations.filter((item) => item.kind === "validation" && item.candidate.id === lineage.candidate.id);
  requireFact(validation.length === 1);
  return assembleLineage({ candidate: lineage.candidate, observations: [...lineage.observations, {
    source: "tabellio", sourceId: review.digest, kind: "security", candidate: lineage.candidate,
    status, observedAt: review.observedAt,
    links: [{ relation: "validates", source: validation[0].source, sourceId: validation[0].sourceId, basis: "explicit" }],
    metadata: { refs: [{ kind: "security_digest", value: review.digest }, { kind: "packet_digest", value: packet.digest }, { kind: "policy_digest", value: policyDigest }] },
  }] });
}
