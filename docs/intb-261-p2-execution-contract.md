# INTB-261 P2 Analytics Validator Execution Contract

## Outcome

Build a standalone analytics validator that emits durable, evidence-safe
`passed`, `failed`, or `blocked` validator evidence for the merged P1b dataset
and provider-snapshot contracts.

Acceptance authority is INTB-261, the 19 P2 entries in
`docs/intb-261-pr28-thread-ledger.json`, and
`docs/intb-261-review-remediation-strategy.md`.

## Owned Surfaces

- `scripts/tabellio-analytics-validator.mjs`
- focused analytics-validator tests
- validator package and validation-manifest wiring
- this execution contract

## Required Invariants

1. Unreadable, malformed, structurally invalid, or unsafe inputs produce
   `blocked` evidence when an evidence output can be written.
2. Valid inputs that fail a semantic, workflow, operational, or security
   requirement produce `failed` evidence.
3. Evidence summaries and artifacts contain no source bodies, credentials, or
   local paths.
4. Semantic validation counts unique repositories with collected Git evidence
   and requires the exact caller-declared repository set.
5. Every required or provider-backed repository binds one exact provider
   snapshot, including unavailable and blocked provider-source states.
6. Delivery rows, provider-source versions, source digests, repository heads,
   and exact-validation claims agree with the committed dataset and supplied
   exact validation result.
7. Delivery metrics are recomputed from validated trace rows.
8. Evidence mode preserves non-passing evidence without converting it to a
   successful product decision.
9. Validation is local, deterministic, and reports complete `$0` telemetry.

## Forbidden Outcomes

- No Buildkite, release, Plane, deployment, joiner, report, or baseline work
  owned by P3-P9.
- No provider reads or writes, deployment, release, billing, Plane mutation,
  paid call, or production-data access.
- No invalid input reported as `failed` or `passed`.
- No valid contract failure reported as `blocked` or `passed`.
- No source body or rejected private value copied into validator evidence.
- No exact validation claim accepted from source availability alone.

## Required Evidence

- One negative fixture for every distinct P2 invariant.
- Focused analytics-validator tests.
- Full repository checks and package dry-run.
- Static, schema, semantic, workflow, operational, and security validation on
  the exact candidate.
- Complete `$0` cost telemetry.
- Terminal Buildkite evidence on the pushed head.
- Fresh hosted review with no unresolved actionable finding.

## Dependency and Handoff

P2 starts from merged P1b. P3-P6 stay unstarted until P2 merges. P7 consumes
the validator, provider collectors, and exact evidence only after P2-P6 merge.
