# INTB-261 P7 Delivery Claim Execution Contract

## Outcome

Join Plane, Buildkite, GitHub Release, and deployment evidence without claiming
delivery success unless each decision is bound to matching source evidence.

Acceptance authority is INTB-261, the 44 P7 entries in
`docs/intb-261-pr28-thread-ledger.json`, and
`docs/intb-261-review-remediation-strategy.md`.

## Owned Surfaces

- delivery evidence snapshot schema and runtime validator
- delivery evidence joiner
- provider Plane-workspace provenance
- focused join, tamper, chronology, and authority tests
- this execution contract

## Required Invariants

1. Plane items match workspace, exact key, and immutable creation time.
2. CI evidence comes from one repository-bound designated Buildkite pipeline.
3. Passed and failed CI decisions bind to an exact build claim digest.
4. Releases are resolved, commit-bound, post-merge, and select the earliest
   eligible observation.
5. Squash merge and proven descendant release commits remain linkable.
6. Deployment receipts match repository, designated environment, and a
   delivery head or landed merge commit.
7. Passed and failed deployment decisions bind to an exact receipt claim
   digest.
8. Blocked sources remain blocked at source and record levels.
9. WIP uses Plane capture time and recomputed count invariants.
10. Imported snapshots reject duplicate rows, unsupported success or failure,
    unsafe text, and evidence newer than capture.

## Forbidden Outcomes

- No delivery report or CLI work owned by P8.
- No baseline publication work owned by P9.
- No provider mutation, deployment, billing, production-data write, or
  credential persistence.
- No cross-repository, cross-workspace, cross-environment, pre-merge, or
  unbound success claim.

## Required Evidence

- Focused positive and tamper tests for each evidence authority.
- Full repository checks and package dry-run.
- Static, schema, semantic, workflow, operational, and security validation on
  the exact candidate.
- Complete `$0` cost telemetry.
- Terminal hosted CI and Buildkite evidence on the pushed head.
- Fresh hosted Codex review with no unresolved actionable finding.

## Dependency and Handoff

P7 starts from merged P6 and consumes P3-P6 provider contracts. P8 starts only
after P7 merges and may render only snapshots accepted by this validator.
