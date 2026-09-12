import { createHash } from "node:crypto";
import { runGit } from "./git-process.mjs";
import { normalizeRecord } from "./provenance-record.mjs";
import { SOURCE_FAILURES } from "./provenance-source-failures.mjs";

const CANDIDATE_FIELDS = ["projectKey", "repositoryId", "baseCommit", "headCommit", "mergeBase"];
const SOURCES = new Set(["plane", "git", "entire", "github", "buildkite", "tabellio"]);
const KINDS = new Set(["task", "run", "commit", "checkpoint", "pull_request", "validation", "review", "security"]);
const AUTHORITIES = { task: "plane", run: "entire", commit: "git", checkpoint: "entire", pull_request: "github", validation: "buildkite", review: "github", security: "tabellio" };
const STATES = new Set(["present", "passed", "failed", "missing", "stale", "conflicting", "inferred", "blocked"]);
const REQUIRED = ["task", "run", "commit", "checkpoint", "pull_request", "validation", "review", "security"];
const PREDECESSOR = { run: "task", commit: "run", checkpoint: "commit", pull_request: "checkpoint", validation: "pull_request", review: "validation", security: "validation" };

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error(`${name} must be bounded nonempty text.`);
  // Reuse the storage boundary, including credential-shaped metadata rejection.
  normalizeRecord({ entityType: "reference", entityKey: value, source: "tabellio", sourceId: name, observedAt: "2026-01-01T00:00:00Z", sensitivity: "private" });
  return value;
}

export function candidateIdentity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Candidate is required.");
  const candidate = Object.fromEntries(CANDIDATE_FIELDS.map((key) => [key, text(input[key], key)]));
  for (const key of ["baseCommit", "headCommit", "mergeBase"]) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidate[key])) throw new Error(`${key} must be an immutable commit ID.`);
  }
  if (new Set([candidate.baseCommit.length, candidate.headCommit.length, candidate.mergeBase.length]).size !== 1) throw new Error("Candidate object formats differ.");
  return { ...candidate, id: digest(candidate) };
}

export async function captureCandidate({ repo, projectKey, repositoryId, base = "main", head = "HEAD" }) {
  const resolve = async (ref) => (await runGit({ cwd: repo, args: ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`] })).stdout.trim();
  const [baseCommit, headCommit] = await Promise.all([resolve(base), resolve(head)]);
  const mergeBase = (await runGit({ cwd: repo, args: ["merge-base", baseCommit, headCommit] })).stdout.trim();
  return candidateIdentity({ projectKey, repositoryId, baseCommit, headCommit, mergeBase });
}

function normalizeObservation(input) {
  if (!input || typeof input !== "object") throw new Error("Observation is required.");
  if (!SOURCES.has(input.source) || !KINDS.has(input.kind)) throw new Error("Unknown observation source or kind.");
  if (AUTHORITIES[input.kind] !== input.source) throw new Error("Observation source does not own this fact.");
  if (!STATES.has(input.status)) throw new Error("Observation status is required.");
  const candidate = candidateIdentity(input.candidate);
  const normalized = normalizeRecord({
    entityType: input.kind, entityKey: input.sourceId, source: input.source, sourceId: input.sourceId,
    observedAt: input.observedAt, projectKey: candidate.projectKey, repositoryId: candidate.repositoryId,
    commitSha: candidate.headCommit, status: input.status, sensitivity: "private",
    payload: input.metadata ?? {},
  });
  if (!Array.isArray(input.links) || input.links.length > 32) throw new Error("Observation needs bounded explicit links.");
  const links = input.links.map(normalizeLink).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const observation = {
    source: input.source, sourceId: normalized.sourceId, kind: input.kind, status: input.status,
    observedAt: normalized.observedAt, candidate, metadata: normalized.payload, links,
  };
  return { ...observation, id: digest(observation) };
}

function normalizeLink(link) {
  if (!link || !["supports", "produced", "reviews", "validates"].includes(link.relation)) throw new Error("Unknown evidence relationship.");
  if (!SOURCES.has(link.source)) throw new Error("Unknown linked source.");
  if (!["explicit", "inferred"].includes(link.basis)) throw new Error("Link basis is required.");
  return { relation: link.relation, source: link.source, sourceId: text(link.sourceId, "linked sourceId"), basis: link.basis };
}

export function assembleLineage({ candidate: input, observations }) {
  const candidate = candidateIdentity(input);
  if (!Array.isArray(observations) || observations.length > 256) throw new Error("Lineage must contain at most 256 observations.");
  const unique = new Map();
  for (const input of observations) {
    const item = normalizeObservation(input);
    unique.set(item.id, item);
  }
  const records = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
  const lineage = { schemaVersion: "tabellio-lineage/v0.1", candidate, observations: records };
  return { ...lineage, digest: digest(lineage) };
}

export function verifyLineage(lineage) {
  const expected = assembleLineage(lineage);
  if (lineage.schemaVersion !== expected.schemaVersion || lineage.digest !== expected.digest || canonicalJson(lineage) !== canonicalJson(expected)) throw new Error("Lineage integrity mismatch.");
  return expected;
}

export function evaluateLineage(lineage, { candidate: current = lineage.candidate, now, maxAgeMs = 86400000 } = {}) {
  const verified = verifyLineage(lineage);
  const evaluatedAt = Date.parse(now);
  if (!Number.isFinite(evaluatedAt) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error("Evaluation needs a valid time and freshness limit.");
  const reasons = [];
  const add = (state, kind, message, evidenceId = null) => reasons.push({ state, kind, message, evidenceId });
  if (candidateIdentity(current).id !== verified.candidate.id) add("stale", "candidate", "Base, head, merge base, or scope changed; capture fresh evidence.");
  const identities = groupObservations(verified.observations);
  for (const versions of identities.values()) {
    if (versions.length > 1) add("conflicting", versions[0].kind, "Multiple observations claim the same source identity; reconcile source versions.", versions[0].id);
  }
  for (const kind of REQUIRED) {
    if (!verified.observations.some((item) => item.kind === kind)) add("missing", kind, `Collect ${kind} evidence from ${AUTHORITIES[kind]}.`);
  }
  for (const item of verified.observations) checkObservation(item, { candidateId: verified.candidate.id, evaluatedAt, maxAgeMs, identities, add });
  const status = reasons.some((reason) => reason.state === "failed") ? "failed" : reasons.length ? "blocked" : "passed";
  return { schemaVersion: "tabellio-lineage-result/v0.1", candidate: verified.candidate, currentCandidate: candidateIdentity(current), lineageDigest: verified.digest, evaluatedAt: new Date(evaluatedAt).toISOString(), status, reasons };
}

function groupObservations(observations) {
  const identities = new Map();
  for (const item of observations) {
    const key = `${item.source}\0${item.sourceId}`;
    const versions = identities.get(key) ?? [];
    versions.push(item);
    identities.set(key, versions);
  }
  return identities;
}

function checkObservation(item, context) {
  const { candidateId, evaluatedAt, maxAgeMs, identities, add } = context;
  if (item.candidate.id !== candidateId) add("conflicting", item.kind, "Evidence refers to another exact candidate.", item.id);
  const age = evaluatedAt - Date.parse(item.observedAt);
  if (age < 0 || age > maxAgeMs) add("stale", item.kind, "Refresh observation from its original source.", item.id);
  const failure = Object.hasOwn(SOURCE_FAILURES, item.metadata.reason) ? SOURCE_FAILURES[item.metadata.reason] : null;
  if (!["present", "passed"].includes(item.status)) add(item.status, item.kind, failure?.message ?? "Resolve source evidence before review readiness.", item.id);
  if (["validation", "review", "security"].includes(item.kind) && item.status === "present") add("blocked", item.kind, "An observation is not a passed result.", item.id);
  if (PREDECESSOR[item.kind] && !hasPredecessor(item, identities)) add("missing", item.kind, `Link this fact to its ${PREDECESSOR[item.kind]} source record.`, item.id);
  checkLinks(item, identities, add);
}

function hasPredecessor(item, identities) {
  return item.links.some((link) => {
    if (link.basis !== "explicit") return false;
    const targets = identities.get(`${link.source}\0${link.sourceId}`) ?? [];
    return targets.some((target) => target.kind === PREDECESSOR[item.kind] && target.candidate.id === item.candidate.id);
  });
}

function checkLinks(item, identities, add) {
  for (const link of item.links) {
    if (link.basis !== "explicit") add("inferred", item.kind, "Inferred links cannot establish readiness.", item.id);
    const targets = identities.get(`${link.source}\0${link.sourceId}`);
    if (!targets) add("missing", item.kind, "Linked source record is missing.", item.id);
    else if (targets.every((entry) => entry.id === item.id)) add("conflicting", item.kind, "Self-links cannot support a change journey.", item.id);
  }
}

export function buildReviewPacket(lineage, options) {
  const result = evaluateLineage(lineage, options);
  const facts = lineage.observations.filter((item) => item.candidate.id === result.currentCandidate.id).map(({ id, source, sourceId, observedAt, kind, status, candidate }) => ({
    id, source, sourceId, observedAt, kind, status, candidateId: candidate.id,
  }));
  const packet = {
    schemaVersion: "tabellio-review-packet/v0.1", authoritative: false,
    candidate: result.currentCandidate, lineageDigest: lineage.digest, status: result.status,
    reasons: result.reasons, facts,
    redactions: ["Source payloads, raw content, and private checkpoint metadata are omitted."],
  };
  const envelope = { ...packet, digest: digest(packet) };
  // Include the CLI's two-space formatting and final newline in the wire limit.
  if (Buffer.byteLength(`${JSON.stringify(envelope, null, 2)}\n`) > 65536) throw new Error("Review packet exceeds 65536 bytes; narrow the evidence set.");
  return envelope;
}
