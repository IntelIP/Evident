import { runGit } from "./git-process.mjs";
import { candidateIdentity, captureCandidate, assembleLineage } from "./provenance-ledger.mjs";
import { validatePlaneWorkItemSnapshot } from "./plane-work-item-collector.mjs";
import { validateLedgerSnapshot } from "./ledger-provider.mjs";
import { validateBuildkiteBuildSnapshot } from "./buildkite-build-collector.mjs";
import { validateValidationResult } from "./validation-runner.mjs";

const SOURCES = ["plane", "git", "entire", "github", "buildkite"];
const PRIMARY_KIND = { plane: "task", git: "commit", entire: "checkpoint", github: "pull_request", buildkite: "validation" };

export async function captureGitSource({ repo, candidate, capturedAt = new Date().toISOString() }) {
  const expected = candidateIdentity(candidate);
  const actual = await captureCandidate({ repo, ...expected, base: expected.baseCommit, head: expected.headCommit });
  requireFact(actual.id === expected.id, "candidate_mismatch");
  const trailer = async (key) => (await runGit({ cwd: repo, args: ["show", "-s", `--format=%(trailers:key=${key},valueonly)`, expected.headCommit] })).stdout.trim();
  const [taskIdentifier, checkpointId] = await Promise.all([trailer("Plane-Work-Item"), trailer("Entire-Checkpoint")]);
  return { schemaVersion: "tabellio-git-source/v0.1", capturedAt, candidate: expected, taskIdentifier, checkpointId };
}

// Reader functions own authentication and transport. This boundary performs no
// provider writes, keeps successful sources when another fails, and never keeps
// an exception message or raw provider body in the derived record.
export async function collectProvenanceSources({ candidate, selection, readers, now = new Date().toISOString() }) {
  const snapshots = {};
  await Promise.all(SOURCES.map(async (source) => {
    try {
      requireFact(typeof readers?.[source] === "function", "reader_missing");
      snapshots[source] = await readers[source]();
    } catch (error) {
      snapshots[source] = { failure: transportFailure(error) };
    }
  }));
  return importProvenanceSources({ candidate, selection, snapshots, now });
}

function importProvenanceSources({ candidate: input, selection, snapshots, now }) {
  const candidate = candidateIdentity(input);
  requireFact(selection && typeof selection === "object", "selection_missing");
  const context = { candidate, selection, snapshots, now };
  const observations = [];
  const sources = [];
  for (const source of SOURCES) {
    try {
      const snapshot = snapshots?.[source];
      requireFact(snapshot && !snapshot.failure, snapshot?.failure ?? "source_missing");
      const imported = MAPPERS[source](snapshot, context);
      // Enforce the same privacy, identity, and size contract before reporting
      // successful normalization. Other sources remain independently useful.
      const checked = assembleLineage({ candidate, observations: imported });
      observations.push(...checked.observations);
      sources.push({ source, status: "present", observationIds: checked.observations.map((item) => item.id) });
    } catch (error) {
      const reason = safeFailure(error);
      observations.push(observe(context, source, `${source}:unavailable`, PRIMARY_KIND[source], "blocked", [], now, { reason }));
      sources.push({ source, status: "blocked", reason });
    }
  }
  const lineage = assembleLineage({ candidate, observations });
  return { schemaVersion: "tabellio-source-import/v0.1", sources, lineage };
}

const MAPPERS = { plane: planeSource, git: gitSource, entire: entireSource, github: githubSource, buildkite: buildkiteSource };

function planeSource(snapshot, context) {
  validatePlaneWorkItemSnapshot(snapshot);
  requireFact(snapshot.status === "available", "source_unavailable");
  const item = snapshot.workItems.find((item) => item.id === context.selection.taskId);
  requireFact(item, "record_missing");
  const project = snapshot.projects.find((project) => project.id === item.projectId);
  requireFact(project?.identifier === context.candidate.projectKey, "scope_mismatch");
  const identifier = `${project.identifier}-${item.sequenceNumber}`;
  requireFact(identifier === context.selection.taskIdentifier, "association_missing");
  return [observe(context, "plane", item.id, "task", "present", [], snapshot.capturedAt)];
}

function gitSource(snapshot, context) {
  requireFact(snapshot.schemaVersion === "tabellio-git-source/v0.1", "malformed_response");
  requireFact(candidateIdentity(snapshot.candidate).id === context.candidate.id, "candidate_mismatch");
  requireFact(snapshot.taskIdentifier === context.selection.taskIdentifier, "association_missing");
  requireFact(snapshot.checkpointId === context.selection.checkpointId, "association_missing");
  return [observe(context, "git", context.candidate.headCommit, "commit", "present", [link("entire", context.selection.sessionId)], snapshot.capturedAt)];
}

function entireSource(snapshot, context) {
  validateLedgerSnapshot(snapshot);
  requireFact(snapshot.repository.id === context.candidate.repositoryId, "scope_mismatch");
  requireFact(snapshot.range.headCommit === context.candidate.headCommit && snapshot.range.baseCommit === context.candidate.baseCommit, "candidate_mismatch");
  const checkpoint = snapshot.checkpoints.find((item) => item.id === context.selection.checkpointId);
  requireFact(checkpoint && !checkpoint.partial, "record_missing");
  requireFact(checkpoint.commits.includes(context.candidate.headCommit), "association_missing");
  const session = checkpoint.sessions.find((item) => item.id === context.selection.sessionId);
  requireFact(session && !session.error, "record_missing");
  return [
    observe(context, "entire", session.id, "run", "present", [link("plane", context.selection.taskId)], snapshot.capturedAt),
    observe(context, "entire", checkpoint.id, "checkpoint", "present", [link("git", context.candidate.headCommit)], snapshot.capturedAt),
  ];
}

function githubSource(snapshot, context) {
  const pr = snapshot.changeRequest;
  requireFact(pr?.number === context.selection.pullRequestNumber, "record_missing");
  requireFact(snapshot.repositoryId === context.candidate.repositoryId, "scope_mismatch");
  requireFact(pr.source?.commit === context.candidate.headCommit && pr.target?.commit === context.candidate.baseCommit, "candidate_mismatch");
  requireFact(pr.state === "open" && !pr.draft, "review_not_ready");
  requireFact(Array.isArray(snapshot.reviews), "malformed_response");
  const review = snapshot.reviews.find((item) => item.id === context.selection.reviewId);
  requireFact(review?.commit === context.candidate.headCommit, "record_missing");
  // GitHub approval alone does not prove which base/merge-base was reviewed.
  const marker = `Tabellio-Candidate: ${context.candidate.id}`;
  requireFact(typeof review.body === "string" && review.body.split(/\r?\n/).includes(marker), "review_binding_missing");
  const status = review.state === "approved" ? "passed" : review.state === "changes_requested" ? "failed" : "blocked";
  return [
    observe(context, "github", pullRequestId(context), "pull_request", "present", [link("entire", context.selection.checkpointId)], snapshot.capturedAt),
    observe(context, "github", review.id, "review", status, [link("buildkite", buildId(context))], snapshot.capturedAt),
  ];
}

function buildkiteSource(input, context) {
  const snapshot = validateBuildkiteBuildSnapshot(input.snapshot);
  requireFact(snapshot.status === "available", "source_unavailable");
  requireFact(snapshot.repository === context.candidate.repositoryId, "scope_mismatch");
  requireFact(snapshot.organization === context.selection.organization && snapshot.pipeline === context.selection.pipeline, "scope_mismatch");
  const build = snapshot.builds.find((item) => item.number === context.selection.buildNumber);
  requireFact(build?.commit === context.candidate.headCommit, "candidate_mismatch");
  validateValidationResult(input.validation);
  const validation = input.validation;
  requireFact(validation.repository.id === context.candidate.repositoryId, "scope_mismatch");
  const validatedCandidate = candidateIdentity({ ...context.candidate, ...validation.revision });
  requireFact(validatedCandidate.id === context.candidate.id, "candidate_mismatch");
  requireFact(validation.suite.manifestDigest === context.selection.manifestDigest, "manifest_mismatch");
  // A green CI build without an exact-candidate validation result stays blocked.
  const status = build.state === "failed" || validation.status === "failed" ? "failed" :
    build.state === "passed" && validation.status === "passed" ? "passed" : "blocked";
  return [observe(context, "buildkite", buildId(context), "validation", status, [link("github", pullRequestId(context))], snapshot.capturedAt,
    { refs: [{ kind: "manifest_digest", value: validation.suite.manifestDigest }, { kind: "validation_digest", value: validation.integrity.digest }] })];
}

function observe(context, source, sourceId, kind, status, links, observedAt, metadata = {}) {
  return { source, sourceId, kind, status, links, observedAt, metadata, candidate: context.candidate };
}

function link(source, sourceId) { return { relation: "supports", source, sourceId, basis: "explicit" }; }
function pullRequestId({ candidate, selection }) { return `${candidate.repositoryId}#${selection.pullRequestNumber}`; }
function buildId({ selection }) { return `${selection.organization}/${selection.pipeline}/${selection.buildNumber}`; }
function requireFact(condition, reason) { if (!condition) throw Object.assign(new Error("Source evidence is blocked."), { sourceFailure: reason }); }
function transportFailure(error) {
  const status = error?.status ?? error?.statusCode;
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404) return "record_missing";
  return "source_unavailable";
}
const FAILURES = new Set(["authentication", "permission", "record_missing", "source_unavailable", "reader_missing", "source_missing", "selection_missing", "candidate_mismatch", "scope_mismatch", "association_missing", "malformed_response", "review_not_ready", "review_binding_missing", "manifest_mismatch"]);
function safeFailure(error) { return FAILURES.has(error?.sourceFailure) ? error.sourceFailure : "malformed_response"; }
