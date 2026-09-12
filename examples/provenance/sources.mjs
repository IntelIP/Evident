import { readFile } from "node:fs/promises";
import { digestObject } from "../../scripts/lib/stack-operation.mjs";

// External provider snapshots are synthetic. Git capture is replaced by the CLI.
export async function sampleSourceBundle(candidate, now) {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const stateId = "22222222-2222-4222-8222-222222222222";
  const selection = { taskId: "33333333-3333-4333-8333-333333333333", taskIdentifier: `${candidate.projectKey}-1`, sessionId: "session-example", checkpointId: "abcdef123456", pullRequestNumber: 1, reviewId: "review-1", organization: "example", pipeline: "tabellio", buildNumber: 1, manifestDigest: "c".repeat(64) };
  const example = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
  const entire = await example("../tabellio-ledger/minimal-ledger.json");
  entire.repository.id = candidate.repositoryId;
  entire.capturedAt = now;
  entire.range = { baseCommit: candidate.baseCommit, headCommit: candidate.headCommit };
  entire.checkpoints[0].commits = [candidate.headCommit];
  const validation = await example("../tabellio-validation/minimal-result.json");
  validation.repository.id = candidate.repositoryId;
  validation.revision = { baseCommit: candidate.baseCommit, headCommit: candidate.headCommit, mergeBase: candidate.mergeBase };
  validation.checkpointRevision = { ...validation.revision };
  validation.suite = { id: "sample", manifestPath: "tabellio.validation.json", manifestDigest: selection.manifestDigest };
  validation.runner = { id: "sample", runtime: "node" };
  const { integrity, ...unsigned } = validation;
  integrity.digest = digestObject(unsigned);
  const snapshots = {
    plane: { schemaVersion: "tabellio-plane-work-items/v0.1", workspace: "sample", capturedAt: now, status: "available", reason: null,
      projects: [{ id: projectId, identifier: candidate.projectKey }], states: [{ id: stateId, projectId, group: "backlog" }],
      workItems: [{ id: selection.taskId, projectId, stateId, sequenceNumber: 1, createdAt: now, updatedAt: now, targetDate: null }] },
    git: { schemaVersion: "tabellio-git-source/v0.1", capturedAt: now, candidate, taskIdentifier: selection.taskIdentifier, checkpointId: selection.checkpointId },
    entire,
    github: { repositoryId: candidate.repositoryId, capturedAt: now,
      changeRequest: { number: 1, state: "open", draft: false, source: { commit: candidate.headCommit }, target: { commit: candidate.baseCommit } },
      reviews: [{ id: selection.reviewId, state: "approved", commit: candidate.headCommit, body: `Tabellio-Candidate: ${candidate.id}` }] },
    buildkite: { snapshot: { schemaVersion: "tabellio-buildkite-build-snapshot/v0.1", repository: candidate.repositoryId, organization: "example", pipeline: "tabellio", capturedAt: now, status: "available", reason: null,
      builds: [{ number: 1, commit: candidate.headCommit, state: "passed", createdAt: "2026-07-10T12:00:00.000Z", finishedAt: "2026-07-10T12:00:01.000Z", jobCount: 1, artifactCount: 1 }] }, validation },
  };
  return { candidate, selection, snapshots };
}
