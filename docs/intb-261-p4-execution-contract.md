# INTB-261 P4 GitHub Release Evidence Execution Contract

## Outcome

Build bounded GitHub Release collection and exact release linking that supports
portable tags, complete inventories, squash merges, commit containment, and
temporal provenance.

Acceptance authority is INTB-261, the 20 P4 entries in
`docs/intb-261-pr28-thread-ledger.json`, and
`docs/intb-261-review-remediation-strategy.md`.

## Owned Surfaces

- `scripts/lib/paged-api-collector.mjs`
- `scripts/lib/github-release-collector.mjs`
- `scripts/lib/github-release-linker.mjs`
- `scripts/lib/git-commit-containment.mjs`
- `scripts/tabellio-github-releases.mjs`
- `scripts/tabellio-analytics-releases.mjs`
- `schemas/github-release-snapshot.v0.1.schema.json`
- the provider fields required to carry landed and release commit identity
- focused release collector, linker, and CLI tests
- package and validation-manifest wiring
- this execution contract

## Required Invariants

1. Release inventory pagination has finite page and item limits and rejects a
   repeated full page.
2. All pages are collected before any delivery change is declared unreleased.
3. Malformed published releases block the snapshot; post-cutoff releases are
   excluded without discarding valid pre-cutoff releases.
4. Release IDs and tag names are unique.
5. Collector and schema accept the same safe slash-delimited Git tag grammar,
   including common portable `+` characters.
6. Every published release timestamp is no later than snapshot capture.
7. Provider and release snapshots are validated and repository-bound before
   linking.
8. A squash-merged change uses its landed merge commit, not its pre-merge PR
   head, for release containment.
9. A release matches only when the landed commit is contained by the release
   commit.
10. Pre-merge releases are ineligible; the earliest eligible containing
    release wins deterministically.
11. Existing conflicting release claims fail closed.
12. Linking never rolls GitHub source provenance backward.
13. Linker output cannot directly or indirectly alias either input, including
    symlink and hard-link aliases.

## Forbidden Outcomes

- No Plane, deployment, delivery joiner, report, or baseline work owned by
  P5-P9.
- No GitHub release write, provider mutation, deployment, billing, Plane
  mutation, paid call, or production-data access.
- No truncated release inventory reported as complete.
- No release linked by tag name, timestamp equality, or raw commit equality
  when containment evidence is required.
- No pre-merge, post-capture, duplicate, malformed, or filesystem-aliased
  evidence accepted.

## Required Evidence

- One negative fixture for every distinct P4 invariant.
- Focused release collector, linker, and CLI tests.
- Full repository checks and package dry-run.
- Static, schema, semantic, workflow, operational, and security validation on
  the exact candidate.
- Complete `$0` cost telemetry.
- Terminal hosted CI and Buildkite evidence on the pushed head.
- Fresh hosted Codex review with no unresolved actionable finding.

## Dependency and Handoff

P4 starts from merged P3. P5 starts only after P4 merges. P7 consumes the
release snapshot only after P3-P6 merge.
