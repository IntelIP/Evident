# INTB-261 P5 Plane Collector Execution Contract

## Outcome

Build a bounded Plane snapshot collector that fails closed on malformed,
duplicate, incomplete, cross-project, or temporally incoherent work-item data.

Acceptance authority is INTB-261, the 12 P5 entries in
`docs/intb-261-pr28-thread-ledger.json`, and
`docs/intb-261-review-remediation-strategy.md`.

## Owned Surfaces

- `scripts/lib/plane-work-item-collector.mjs`
- `scripts/tabellio-plane-work-items.mjs`
- `schemas/plane-work-item-snapshot.v0.1.schema.json`
- focused Plane collector and CLI tests
- package and validation-manifest wiring
- this execution contract

## Required Invariants

1. State requests use finite concurrency.
2. Cursor pagination has finite page and item limits.
3. Work-item timestamps satisfy `createdAt <= updatedAt <= capturedAt`.
4. Project identifiers use the uppercase delivery-schema grammar and are unique.
5. Every malformed provider row blocks the snapshot.
6. Every state belongs to the project used to request it.
7. Work-item IDs are unique.
8. Every state references an included owning project.
9. Plane identifiers align with the delivery schema.
10. Incomplete work-item normalization blocks the snapshot.
11. Project-plus-sequence delivery keys are unique.
12. Incomplete or repeated pagination metadata blocks the snapshot.

## Forbidden Outcomes

- No deployment, delivery joiner, report, or baseline work owned by P6-P9.
- No Plane write, provider mutation, deployment, billing, paid call, or
  production-data access.
- No truncated, malformed, duplicate, dangling, cross-project, future-dated,
  credential-bearing, or filesystem-aliased evidence accepted.

## Required Evidence

- One negative fixture for every distinct P5 invariant.
- Focused Plane collector, snapshot, schema, and CLI tests.
- Full repository checks and package dry-run.
- Static, schema, semantic, workflow, operational, and security validation on
  the exact candidate.
- Complete `$0` cost telemetry.
- Terminal hosted CI and Buildkite evidence on the pushed head.
- Fresh hosted Codex review with no unresolved actionable finding.

## Dependency and Handoff

P5 starts from merged P4. P6 starts only after P5 merges. P7 consumes the Plane
snapshot only after P3-P6 merge.
