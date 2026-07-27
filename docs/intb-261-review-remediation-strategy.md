# INTB-261 Review Remediation Strategy

## Purpose

Turn PR #28 review discovery into small, independently reviewable changes.
PR #28 (`codex/intb-261-analytics`) is frozen at
`33217d6d91470ce77bdbd96f749ed7127be50ab4`. It remains review evidence and
is not a merge candidate.

This strategy does not authorize merge, release, deployment, provider writes,
or Plane mutation.

## Review Inventory

Snapshot: GitHub PR #28 review threads read 2026-07-27 from frozen head
`33217d6d91470ce77bdbd96f749ed7127be50ab4`.

- 160 unresolved threads: 47 P1, 112 P2, 1 P3.
- `docs/intb-261-pr28-thread-ledger.json` records every frozen unresolved
  thread ID, path, line, invariant, and successor destination. It is the
  durable reconciliation input; no successor may silently omit a source thread.
- `docs/intb-261-successor-finding-ledger.json` is separate and starts empty.
  It records and routes every finding discovered after this frozen PR #28
  snapshot without changing the frozen provenance or 160-thread count.
- Findings repeat across a small set of contract failures. A successor fixes
  one invariant and its adversarial fixture, not one comment body.
- Each successor PR links every addressed thread, and its PR description
  records `thread -> invariant -> fixture -> exact-head evidence`.
- A new finding is either a duplicate of an existing invariant, a regression
  in the PR that owns that invariant, or an entry in the separate
  successor-finding ledger. It is never appended to the frozen ledger or an
  unrelated successor.

## Shared Invariants

1. Portable evidence excludes credentials, local paths, transcript bodies,
   unsafe identifiers, and unallowlisted fields.
2. Every passed claim binds the exact repository, commit, source observation,
   and source-specific evidence record.
3. Missing, malformed, incomplete, rate-limited, or unavailable evidence stays
   unavailable or blocked; it never becomes zero, passed, shipped, deployed,
   or healthy.
4. Remote inventories are paginated, deduplicated, temporally coherent, and
   provider-owned before they can affect delivery decisions.
5. CLI outputs cannot overwrite inputs or render unescaped external text.

## Successor PR Chain

| PR | Branch | Bounded outcome | Owned surfaces | Depends on |
| --- | --- | --- | --- | --- |
| 0 | `agent/intb-261-review-ledger` | Durable grouping and review-loop rules. No product behavior. | This document | None |
| B0 | `agent/tabellio-buildkite-bootstrap` | **Merged as PR #32.** Minimal reviewed Buildkite bootstrap is on `main`. | `.buildkite` pipeline/bootstrap only, focused checks | 0 |
| P1a | `agent/intb-261-portable-evidence-contract` | **Merged as PR #33.** Reject unsafe, incomplete, and contradictory portable evidence. | `scripts/lib/portable-evidence.mjs`, focused tests | B0 |
| P1b | `agent/intb-261-analytics-core` | Build analytics core on the merged portable contract. | analytics core, schemas, focused tests | P1a |
| P2 | `agent/intb-261-analytics-validator` | Validator emits truthful passed or failed evidence and preserves valid unavailable states. | `scripts/tabellio-analytics-validator.mjs`, `tabellio.validation.json`, focused tests | P1b |
| P3 | `agent/intb-261-buildkite-collector` | Buildkite inventory is complete and exact evidence is repository-bound. | `scripts/lib/buildkite-build-collector.mjs`, `.buildkite/scripts/product-validation.sh`, focused tests | P1b |
| P4 | `agent/intb-261-release-evidence` | Release collection/linking supports valid tags, complete pages, and temporal provenance. | release collector/linker, release schemas, focused tests | P1b |
| P5 | `agent/intb-261-plane-collector` | Plane snapshots reject malformed, duplicate, and cross-project state data. | `scripts/lib/plane-work-item-collector.mjs`, focused tests | P1b |
| P6 | `agent/intb-261-deployment-receipts` | Deployment receipts and collectors are portable, repository-bound, and parse their documented options. | deployment receipt schema, deployment collectors, focused tests | P1b |
| P7 | `agent/intb-261-delivery-claims` | Joined delivery records cannot claim CI, release, or deployment success without matching source evidence. | `scripts/lib/delivery-evidence-joiner.mjs`, focused tests | P2, P3, P4, P5, P6 |
| P8 | `agent/intb-261-delivery-cli-report` | Delivery CLI protects inputs; report recomputes WIP and escapes external text. | delivery CLI, report renderer, focused tests | P7 |
| P9 | `agent/intb-261-baseline-integration` | Rebuilt baseline, package inclusion, and merged-head Buildkite checkpoint behavior. | analytics reports, package manifest, merged-head integration checks, focused tests | P8 |

## Finding Assignment Rules

| Finding class | Destination |
| --- | --- |
| Credential/path leakage, raw provider fields, malformed IDs, source/head mismatch, canonical metric shape | P1b for analytics core and schemas; P2 for validator output or security checks; P6 for deployment receipt identifiers |
| Evidence-mode crash, unavailable-state semantics, validator summary/output shape, required metric coverage | PR 2 |
| Buildkite pagination, pipeline/repository provenance, per-build evidence identity | PR 3 |
| Release pagination, valid Git tag grammar, release capture timing, release/source identity | PR 4 |
| Plane pagination, duplicate items, malformed item rejection, state-project ownership, WIP input consistency | PR 5 |
| Deployment receipt portability, repository/commit binding, Cloud Run/Vercel collector option behavior | PR 6 |
| CI/release/deployment claim digest, provider availability, source conflict, cross-repository evidence binding | PR 7 |
| Input-output aliasing, report injection, derived WIP consistency, CLI rendering | PR 8 |
| Packaged analytics artifacts, regenerated baseline/source digest, squash-merge checkpoint resolution | PR 9 |

## Review and Evidence Protocol

1. B0 and P1a are merged. Start P1b from current `origin/main`; do not stack
   code branches. P3 owns both its collector and the Buildkite product-
   validation script assigned to its frozen ledger records; P9 owns only the
   final integration checkpoint behavior.
2. One successor merges before its dependent successor is created. Rebase is not
   a substitute for rerunning exact-head evidence.
3. Before review, add a negative fixture for every addressed invariant, run
   focused tests, then run the required manifest validation on the candidate.
4. Push the exact candidate and require terminal Buildkite evidence for that
   same SHA. A local pass alone is blocked from review readiness.
5. Request review only for the declared surfaces. Thread replies/resolution
   require separate authority after the fix and exact-head evidence exist.
6. If review finds a new invariant, stop the current repair loop and add it to
   the separate successor-finding ledger with its source PR/head, review-thread
   identity, invariant, and ownership decision. Route it by the finding-
   assignment and dependency rules. Do not force it into the numerically next
   successor; keep the current PR bounded.

## Resolved Hosted-Evidence Blocker

Buildkite builds [#31](https://buildkite.com/intelip/tabellio/builds/31) and
[#32](https://buildkite.com/intelip/tabellio/builds/32) exposed the former
pipeline-upload absence. B0 extracted the minimal bootstrap and merged as
PR #32; P1a then merged as PR #33. This is resolved historical evidence, not
a current successor blocker. Every new successor still requires terminal
Buildkite evidence on its own exact candidate head.

## WIP and Stop Conditions

INTB's started-WIP cap is three. This chain is serial under one integration
owner: no parallel successor code worktrees. Keep unstarted successors in
Refine until their dependencies are merged and their Definition of Ready is
complete.

Stop and return to refinement when a finding requires a product policy choice,
new provider authority, production data, deployment, spending, merge,
publication, or a new architecture boundary.

## Definition of Done for PR #9

- Every PR #28 finding is either addressed by a merged successor, documented
  as duplicate with its owning invariant, or retained as an explicit accepted
  non-goal.
- Current baseline/report/source artifacts agree on exact source identities and
  digest.
- Required validators, package dry-run, Fallow, and Buildkite pass on the
  exact final head.
- Fresh review has no unresolved actionable findings.
- PR #28 disposition is explicitly decided. No merge occurs without separate
  user approval.
