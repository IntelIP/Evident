# INTB-261 P1b Analytics Core Execution Contract

## Outcome

Build the smallest analytics core that can accept portable evidence, preserve
unknown states, bind claims to exact Git and provider identities, and emit a
deterministic dataset. This PR owns the 25 frozen PR #28 findings assigned to
`P1b` in `docs/intb-261-pr28-thread-ledger.json`.

Acceptance authority is INTB-261, the frozen thread ledger, and
`docs/intb-261-review-remediation-strategy.md`.

## Owned Surfaces

- `scripts/lib/analytics.mjs`
- `scripts/tabellio-analytics.mjs`
- `schemas/analytics-dataset.v0.1.schema.json`
- focused analytics-core fixtures and tests
- narrowly required reusable output/schema helpers when they do not belong to
  a later successor

## Required Invariants

1. Analytics identifiers, provider text, versions, reasons, control-record
   identifiers, and rendered evidence are portable and credential-safe.
2. Git-backed sources use real commit object IDs and bind source version to the
   repository head.
3. Available sources keep source-backed count and boolean metrics measured.
   Missing or malformed evidence remains unavailable or blocked.
4. Provider timestamps, control records, delivery changes, and observation
   windows are temporally coherent.
5. Delivery metrics are recomputed from validated trace rows rather than
   trusted from imported values.
6. Available control refs resolve directly to commits; malformed ref content
   does not export raw paths or private fragments.
7. Analytics outputs cannot alias configuration, provider snapshots, collected
   repositories, each other, or symbolic-link targets.
8. Canonical repository identity is derived from the repository and remains
   stable for supported GitHub remote forms.

## Forbidden Outcomes

- No validator, Buildkite collector, release collector, Plane collector,
  deployment receipt, delivery join, report, baseline, or packaging work owned
  by P2-P9.
- No provider writes, deployment, release, Plane mutation, paid call, or
  production-data access.
- No reuse of the 74-file PR #28 diff as a single patch.
- No passed claim from stale, missing, cross-repository, or unbound evidence.
- No deletion or publication of the frozen PR #28 branch or ledger.

## Required Evidence

- One negative fixture for every distinct owned invariant.
- Focused analytics-core tests.
- Repository static checks.
- Schema, semantic, workflow, and security validation.
- Complete `$0` cost telemetry.
- Terminal Buildkite evidence for the exact pushed head.
- Fresh hosted review with no unresolved actionable finding.

## Dependency and Handoff

P1b starts from merged P1a on current `main`. P2-P6 remain unstarted until P1b
merges. P1b hands them a stable analytics dataset and portable evidence
contract; it does not implement their provider-specific behavior.
