# INTB-261 Review Remediation Strategy

## Purpose

Turn PR #28 review discovery into small, independently reviewable changes.
PR #28 (`codex/intb-261-analytics`) is frozen at
`33217d6d91470ce77bdbd96f749ed7127be50ab4`. It remains review evidence and
is not a merge candidate.

This strategy does not authorize merge, release, deployment, provider writes,
or Plane mutation.

## Review Inventory

Snapshot: GitHub PR #28 review threads read 2026-07-27.

- 160 unresolved threads: 47 P1, 112 P2, 1 P3.
- Findings repeat across a small set of contract failures. A successor fixes
  one invariant and its adversarial fixture, not one comment body.
- Each successor PR links every addressed thread, and its PR description
  records `thread -> invariant -> fixture -> exact-head evidence`.
- A new finding is either a duplicate of an existing invariant, a regression
  in the PR that owns that invariant, or a new PR-0 ledger entry. It is never
  appended to an unrelated successor.

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
| B0 | `agent/tabellio-buildkite-bootstrap` | Put the minimal reviewed Buildkite bootstrap on `main` so successor PRs can produce hosted evidence. | `.buildkite` pipeline/bootstrap only, focused checks | 0 |
| 1 | `agent/intb-261-portable-evidence-contract` | Reject unsafe, incomplete, and contradictory analytics evidence. | `scripts/lib/analytics.mjs`, analytics schemas, focused tests | B0 |
| 2 | `agent/intb-261-analytics-validator` | Validator emits truthful passed or failed evidence and preserves valid unavailable states. | `scripts/tabellio-analytics-validator.mjs`, `tabellio.validation.json`, focused tests | 1 |
| 3 | `agent/intb-261-buildkite-collector` | Buildkite inventory is complete and exact evidence is repository-bound. | `scripts/lib/buildkite-build-collector.mjs`, focused tests | 1 |
| 4 | `agent/intb-261-release-evidence` | Release collection/linking supports valid tags, complete pages, and temporal provenance. | release collector/linker, release schemas, focused tests | 1 |
| 5 | `agent/intb-261-plane-collector` | Plane snapshots reject malformed, duplicate, and cross-project state data. | `scripts/lib/plane-work-item-collector.mjs`, focused tests | 1 |
| 6 | `agent/intb-261-deployment-receipts` | Deployment receipts and collectors are portable, repository-bound, and parse their documented options. | deployment receipt schema, deployment collectors, focused tests | 1 |
| 7 | `agent/intb-261-delivery-claims` | Joined delivery records cannot claim CI, release, or deployment success without matching source evidence. | `scripts/lib/delivery-evidence-joiner.mjs`, focused tests | 2, 3, 4, 5, 6 |
| 8 | `agent/intb-261-delivery-cli-report` | Delivery CLI protects inputs; report recomputes WIP and escapes external text. | delivery CLI, report renderer, focused tests | 7 |
| 9 | `agent/intb-261-baseline-integration` | Rebuilt baseline, package inclusion, and merged-head Buildkite checkpoint behavior. | analytics reports, package manifest, Buildkite validation script, focused tests | 8 |

## Finding Assignment Rules

| Finding class | Destination |
| --- | --- |
| Credential/path leakage, raw provider fields, malformed IDs, source/head mismatch, canonical metric shape | PR 1 |
| Evidence-mode crash, unavailable-state semantics, validator summary/output shape, required metric coverage | PR 2 |
| Buildkite pagination, pipeline/repository provenance, per-build evidence identity | PR 3 |
| Release pagination, valid Git tag grammar, release capture timing, release/source identity | PR 4 |
| Plane pagination, duplicate items, malformed item rejection, state-project ownership, WIP input consistency | PR 5 |
| Deployment receipt portability, repository/commit binding, Cloud Run/Vercel collector option behavior | PR 6 |
| CI/release/deployment claim digest, provider availability, source conflict, cross-repository evidence binding | PR 7 |
| Input-output aliasing, report injection, derived WIP consistency, CLI rendering | PR 8 |
| Packaged analytics artifacts, regenerated baseline/source digest, squash-merge checkpoint resolution | PR 9 |

## Review and Evidence Protocol

1. Merge B0 before opening PR 1. Then start each successor from current
   `origin/main`; do not stack code branches.
2. One successor merges before its dependent successor is created. Rebase is not
   a substitute for rerunning exact-head evidence.
3. Before review, add a negative fixture for every addressed invariant, run
   focused tests, then run the required manifest validation on the candidate.
4. Push the exact candidate and require terminal Buildkite evidence for that
   same SHA. A local pass alone is blocked from review readiness.
5. Request review only for the declared surfaces. Thread replies/resolution
   require separate authority after the fix and exact-head evidence exist.
6. If review finds a new invariant, stop the current repair loop, add it to
   this ledger's next unstarted destination, and keep the current PR bounded.

## Current Hosted-Evidence Blocker

Buildkite builds [#31](https://buildkite.com/intelip/tabellio/builds/31) and
[#32](https://buildkite.com/intelip/tabellio/builds/32) checked out this PR's
exact head `491880a3a1c9b2d5598a23568827dafb08c0f199`, then failed in the
initial pipeline-upload job before tests ran. The agent reported no default
pipeline configuration file. `origin/main` does not contain the Buildkite
configuration that PR #28 carried, so any clean successor based on `main`
would fail in the same way.

This is CI bootstrap absence, not a strategy-document failure. Keep PR #28
frozen; do not stack successors onto it. B0 is the bounded prerequisite:
extract and review only the minimum safe Buildkite bootstrap needed for the
repository's existing validation flow, merge it separately, then begin PR 1.

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
