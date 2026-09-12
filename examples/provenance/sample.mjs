// Synthetic provider records. The sample's Git candidate is captured separately.
export function sampleObservations(candidate, observedAt = "2026-09-12T12:00:00Z") {
  const facts = [
    ["plane", "SAMPLE-1", "task", "present", null],
    ["entire", "sample-run", "run", "present", ["plane", "SAMPLE-1"]],
    ["git", candidate.headCommit, "commit", "present", ["entire", "sample-run"]],
    ["entire", "0123456789ab", "checkpoint", "present", ["git", candidate.headCommit]],
    ["github", "pr-1", "pull_request", "present", ["entire", "0123456789ab"]],
    ["buildkite", "build-1", "validation", "passed", ["github", "pr-1"]],
    ["github", "review-1", "review", "passed", ["buildkite", "build-1"]],
    ["tabellio", "security-1", "security", "passed", ["buildkite", "build-1"]],
  ];
  return facts.map(([source, sourceId, kind, status, target]) => ({
    source, sourceId, kind, status, candidate, observedAt,
    metadata: { kind: "synthetic fixture" },
    links: target ? [{ relation: "supports", source: target[0], sourceId: target[1], basis: "explicit" }] : [],
  }));
}
