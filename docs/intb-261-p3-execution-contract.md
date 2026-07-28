# INTB-261 P3 Buildkite Collector Execution Contract

## Outcome

Build a bounded Buildkite evidence collector whose inventory is complete,
repository-bound, temporally coherent, and safe to consume as delivery
evidence. Restore exact squash-merge checkpoint validation on Buildkite's
default-branch build.

Acceptance authority is INTB-261, the 15 P3 entries in
`docs/intb-261-pr28-thread-ledger.json`, and
`docs/intb-261-review-remediation-strategy.md`.

## Owned Surfaces

- `scripts/lib/buildkite-build-collector.mjs`
- `scripts/tabellio-buildkite-builds.mjs`
- `schemas/buildkite-build-snapshot.v0.1.schema.json`
- `.buildkite/scripts/product-validation.sh`
- focused Buildkite collector and gate tests
- package and validation-manifest wiring
- this execution contract

## Required Invariants

1. Organization and pipeline slugs accept valid hyphens and reject unsafe
   path syntax.
2. Repository identity is derived from the Buildkite pipeline and must match
   the caller-declared repository.
3. Build, job, and artifact inventories paginate to completion inside finite
   item and page limits.
4. Per-build detail requests run with bounded concurrency.
5. Jobs are present in the documented build response and agree with the
   separately paginated job inventory.
6. Duplicate build numbers, mismatched details, malformed identifiers, and
   timestamps outside `createdAt <= finishedAt <= capturedAt` are rejected.
7. `capturedAt` is sampled after provider collection completes.
8. Provider failures produce one portable blocked reason without copying
   tokens, URLs, or response bodies.
9. Default-branch Buildkite validation resolves squash merges through GitHub
   commit-to-PR evidence, fails closed on lookup/fetch errors, and compares the
   fetched checkpoint with the resolved head.

## Forbidden Outcomes

- No release, Plane, deployment, joiner, report, or baseline work owned by
  P4-P9.
- No Buildkite provider writes, deployment, release, billing, Plane mutation,
  paid call, or production-data access.
- No truncated page reported as complete.
- No caller-provided repository accepted without pipeline provenance.
- No commit-subject inference for squash-merge checkpoint identity.

## Required Evidence

- One negative fixture for every distinct P3 invariant.
- Focused collector and Buildkite gate tests.
- Full repository checks and package dry-run.
- Static, schema, semantic, workflow, operational, and security validation on
  the exact candidate.
- Complete `$0` cost telemetry.
- Terminal Buildkite evidence on the pushed head.
- Fresh hosted review with no unresolved actionable finding.

## Dependency and Handoff

P3 starts from merged P2. P4 starts only after P3 merges. P7 consumes the
Buildkite snapshot only after P3-P6 merge.
