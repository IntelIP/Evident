# INTB-261 P9 execution contract

## Outcome

The shipped package contains a current, decision-grade cross-repository
analytics baseline and every source artifact required to validate it.

## Required outcomes

- The baseline is regenerated with current unavailable reasons and exact source
  digests.
- The Markdown report is a deterministic projection of the baseline dataset.
- Every provider snapshot referenced by semantic validation ships in the npm
  package.
- v0.2 merge and release provenance normalizes into the v0.1 analytics dataset
  without breaking exact source binding.
- Buildkite default-branch validation retains fail-closed merged-checkpoint
  resolution.

## Invariants

- Four repository heads and four provider snapshots bind exactly.
- Missing evidence remains unavailable or blocked, never numeric zero.
- The package and main product-validation manifest use the same baseline digest.
- Validation performs no provider writes, deployment, billing, or paid calls.

## Forbidden outcomes

- A stale metric reason contradicts its provider source.
- Package validation references an omitted report or snapshot.
- Merge provenance fields make a valid v0.2 snapshot impossible to validate.
- A merged-head checkpoint failure is ignored.

## Required validators

Static, schema, semantic, workflow, operational, and security validators must
pass on the exact candidate commit with complete zero-cost telemetry.
