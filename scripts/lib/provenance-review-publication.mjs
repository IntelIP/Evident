import { contract } from "./contract-checks.mjs";
import { digestObject } from "./stack-operation.mjs";
import { validateOperationApproval } from "./approval-validation.mjs";
import { captureCandidate, candidateIdentity } from "./provenance-ledger.mjs";
import { buildProvenanceReviewResult } from "./provenance-review-result.mjs";
import { GitJsonLedger } from "./git-json-ledger.mjs";
import { effectiveGitHubRepository } from "./github-repository.mjs";
import { NativeGitStore } from "../providers/native-git-store.mjs";

const INTENT = "tabellio-provenance-status-intent/v0.1";
const APPROVAL = "tabellio-provenance-status-approval/v0.1";

export function createProvenanceStatusIntent(lineage, options) {
  const result = buildProvenanceReviewResult(lineage, options);
  if (result.github.length !== 2) throw new Error("A GitHub repository identity is required.");
  const unsigned = { schemaVersion: INTENT, createdAt: result.evaluatedAt, candidate: result.currentCandidate, lineageDigest: lineage.digest, reportUrl: options.reportUrl ?? null, statuses: result.github };
  return { ...unsigned, integrity: { algorithm: "sha256", digest: digestObject(unsigned) } };
}

function validateIntent(value) {
  contract.object(value, "intent");
  contract.exactKeys(value, ["schemaVersion", "createdAt", "candidate", "lineageDigest", "reportUrl", "statuses", "integrity"], "intent");
  contract.equals(value.schemaVersion, INTENT, "intent.schemaVersion");
  contract.date(value.createdAt, "intent.createdAt");
  contract.sha256(value.lineageDigest, "intent.lineageDigest");
  contract.equals(digestObject(value.candidate), digestObject(candidateIdentity(value.candidate)), "intent.candidate");
  contract.object(value.integrity, "intent.integrity");
  contract.exactKeys(value.integrity, ["algorithm", "digest"], "intent.integrity");
  contract.equals(value.integrity.algorithm, "sha256", "intent.integrity.algorithm");
  const { integrity, ...unsigned } = value;
  contract.equals(integrity.digest, digestObject(unsigned), "intent.integrity.digest");
  return value;
}

async function assertCurrent(repo, intent, base, head) {
  const actual = await captureCandidate({ repo, projectKey: intent.candidate.projectKey, repositoryId: intent.candidate.repositoryId, base, head });
  contract.equals(actual.id, intent.candidate.id, "current candidate");
  return actual;
}

function checkedResponse(response, expected) {
  for (const key of ["commit", "state", "context", "description", "targetUrl"]) contract.equals(response[key], expected[key], `published.${key}`);
  if (!/^[0-9]{1,20}$/.test(String(response.id))) throw new Error("Invalid published status ID.");
  return { id: String(response.id), commit: response.commit, state: response.state, context: response.context };
}

async function sendStatuses({ repo, intent, base, head, publisher }) {
  const published = [];
  try {
    for (const expected of intent.statuses) {
      await assertCurrent(repo, intent, base, head);
      published.push(checkedResponse(await publisher.publish(expected), expected));
    }
    await assertCurrent(repo, intent, base, head);
    return { status: "published", published };
  } catch {
    return { status: "blocked", published, reason: "Publication failed or became uncertain. Inspect GitHub statuses and the stored receipt before authorizing another attempt." };
  }
}

export async function publishProvenanceStatuses({ repo, lineage, intent, approval, publisher, now, base = "main", head = "HEAD" }) {
  contract.date(now, "publication time");
  validateOperationApproval(approval, intent, { schemaVersion: APPROVAL, validateIntent, now: new Date(now) });
  if (Date.parse(approval.expiresAt) - Date.parse(approval.approvedAt) > 3600000) throw new Error("Status approval must expire within one hour.");
  const candidate = await assertCurrent(repo, intent, base, head);
  contract.equals(lineage.digest, intent.lineageDigest, "lineage digest");
  const result = buildProvenanceReviewResult(lineage, { candidate, now, reportUrl: intent.reportUrl });
  contract.equals(digestObject(result.github), digestObject(intent.statuses), "current status representation");
  const store = await NativeGitStore.open(repo);
  const remote = await effectiveGitHubRepository(store, "origin");
  const target = `${intent.statuses[0].owner}/${intent.statuses[0].repo}`.toLowerCase();
  contract.equals(remote.key, target, "GitHub origin identity");
  const ledger = await GitJsonLedger.open({ repoPath: repo, ref: "refs/tabellio/provenance-statuses" });
  const path = `approvals/${approval.id}.json`;
  const prior = await ledger.read(path);
  if (prior.value !== null) {
    contract.equals(prior.value.intentDigest, intent.integrity.digest, "used approval intent");
    if (prior.value.status !== "pending") return prior.value;
    return { ...prior.value, status: "blocked", reason: "An earlier attempt is unresolved. Inspect GitHub before authorizing another attempt." };
  }
  // Reserve the approval before any network mutation. CAS prevents concurrent
  // consumers and preserves an uncertain attempt if the process stops midway.
  const receipt = { schemaVersion: "tabellio-provenance-status-receipt/v0.1", approvalId: approval.id, intentDigest: intent.integrity.digest, candidateId: candidate.id, attemptedAt: now, status: "pending", published: [] };
  const attempt = await ledger.write(path, receipt, { expectedVersion: prior.version });
  const completed = { ...receipt, ...await sendStatuses({ repo, intent, base, head, publisher }) };
  await ledger.write(path, completed, { expectedVersion: attempt.version });
  return completed;
}
