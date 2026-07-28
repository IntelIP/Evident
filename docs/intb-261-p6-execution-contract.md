# INTB-261 P6 Deployment Receipt Execution Contract

## Outcome

Build portable, repository-bound deployment receipts and read-only Cloud Run
and Vercel collectors that parse their documented options and fail closed.

Acceptance authority is INTB-261, the 10 P6 entries in
`docs/intb-261-pr28-thread-ledger.json`, and
`docs/intb-261-review-remediation-strategy.md`.

## Owned Surfaces

- deployment receipt schema, validator, input normalizer, and example
- Cloud Run and Vercel deployment collectors and CLIs
- focused receipt, provider, and CLI tests
- package and validation-manifest wiring
- this execution contract

## Required Invariants

1. Cloud Run receipt IDs stay inside the 128-character contract.
2. Every exported receipt string rejects credential material and local paths.
3. Cloud Run provenance includes project, region, service, and revision.
4. Blocked collector results preserve a sanitized reason.
5. Free-form receipt fields use portable, bounded grammars.
6. The Vercel CLI accepts parsed `--project-id`.
7. Provenance pointers reject credentialed and machine-local values.
8. Vercel deployment evidence is production-only.
9. Cloud Run receipts require immutable source-repository metadata matching the
   requested repository.
10. Vercel receipts require Git organization and repository metadata matching
    the requested repository.

## Forbidden Outcomes

- No delivery joiner, report, or baseline work owned by P7-P9.
- No deployment, provider mutation, billing, paid call, production-data write,
  or credential persistence.
- No receipt minted from preview, partial-traffic, short-commit,
  cross-repository, malformed, future, credential-bearing, or aliased evidence.

## Required Evidence

- One negative fixture for every distinct P6 invariant.
- Focused receipt, Cloud Run, Vercel, and CLI tests.
- Full repository checks and package dry-run.
- Static, schema, semantic, workflow, operational, and security validation on
  the exact candidate.
- Complete `$0` cost telemetry.
- Terminal hosted CI and Buildkite evidence on the pushed head.
- Fresh hosted Codex review with no unresolved actionable finding.

## Dependency and Handoff

P6 starts from merged P5. P7 starts only after P6 merges and consumes the
deployment receipt contract together with the P3-P5 provider snapshots.
