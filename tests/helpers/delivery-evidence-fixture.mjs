const at = "2026-07-25T12:00:00.000Z";
const commit = "a".repeat(40);
const project = "11111111-1111-1111-1111-111111111111";
const state = "22222222-2222-2222-2222-222222222222";
const item = "33333333-3333-3333-3333-333333333333";

export const fixture = { at, commit };

export function provider() {
  return {
    schemaVersion: "tabellio-analytics-provider-snapshot/v0.1",
    repository: "IntelIP/Tabellio",
    headCommit: commit,
    capturedAt: at,
    sources: {
      plane: {
        status: "available",
        version: at,
        workspace: "intelip",
      },
      github: { status: "available", version: at },
      "github-actions": { status: "available", version: at },
      buildkite: { status: "available", version: at },
    },
    deliveryChanges: [{
      id: "change-1",
      linkBasis: "explicit",
      linkEvidence: null,
      planeStoryId: "INTB-260",
      pullRequestNumber: 27,
      storyCreatedAt: at,
      firstActivityAt: at,
      mergedAt: at,
      releasedAt: null,
      headCommit: commit,
      mergeCommit: commit,
      releaseCommit: null,
      validationStatus: "passed",
      hostedStatus: "passed",
    }],
  };
}

export function plane() {
  return {
    schemaVersion: "tabellio-plane-work-items/v0.1",
    workspace: "intelip",
    capturedAt: at,
    status: "available",
    reason: null,
    projects: [{ id: project, identifier: "INTB" }],
    states: [{ id: state, projectId: project, group: "started" }],
    workItems: [{
      id: item,
      projectId: project,
      stateId: state,
      sequenceNumber: 260,
      createdAt: at,
      updatedAt: at,
      targetDate: null,
    }],
  };
}

export function buildkite() {
  return {
    schemaVersion: "tabellio-buildkite-build-snapshot/v0.1",
    repository: "IntelIP/Tabellio",
    organization: "intelip",
    pipeline: "tabellio",
    capturedAt: at,
    status: "available",
    reason: null,
    builds: [{
      number: 6,
      commit,
      state: "passed",
      createdAt: at,
      finishedAt: at,
      jobCount: 1,
      artifactCount: 1,
    }],
  };
}

export function releases() {
  return {
    schemaVersion: "tabellio-github-release-snapshot/v0.1",
    repository: "IntelIP/Tabellio",
    capturedAt: at,
    status: "available",
    reason: null,
    releases: [{
      id: "1",
      tagName: "v0.5.0",
      publishedAt: at,
      commit,
      commitStatus: "resolved",
    }],
  };
}

export function deployment(overrides = {}) {
  return {
    schemaVersion: "tabellio-deployment-receipt/v0.1",
    id: "deploy-1",
    repository: "IntelIP/Tabellio",
    environment: "production",
    commit,
    status: "passed",
    deployedAt: at,
    observedAt: at,
    provider: "cloud-run",
    externalId: "revision-1",
    releaseTag: null,
    provenancePointer: "cloud-run:revision-1",
    ...overrides,
  };
}
