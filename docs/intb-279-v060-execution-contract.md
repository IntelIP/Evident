# INTB-279: Tabellio v0.6.0 Identity Contract

## Required outcomes

- `package.json`, the changelog, and release notes identify version `0.6.0`.
- `tabellio-version` emits JSON containing the package name and version, exact Git commit, source cleanliness, and matching release tag when one exists.
- New validation results use `tabellio-validation-result/v0.4` and bind the same runner identity.
- Readers continue to accept validation-result versions v0.1 through v0.3.

## Invariants

- Inspection is local and read-only.
- Unavailable Git identity remains `null`; it is never inferred.
- Dirty source remains visible as `sourceDirty: true`.
- No filesystem path or source content is included in runner identity.
- Every required validator has available zero-cost telemetry.

## Forbidden outcomes

- Package, evidence, and release-note versions diverge.
- A missing or mismatched tag is represented as released.
- A moved commit reuses earlier validation evidence.
- Release publication, merge, deployment, billing, DNS, or consumer-repository mutation occurs without its separate approval.

## Validation

The exact candidate commit must pass:

- `tabellio.v060-identity.validation.json`
- `tabellio.validation.json`
- repository checks and tests
- package dry-run inspection
- hosted CI and terminal review sync after push

The release is not shipped until a GitHub Release for tag `v0.6.0` exists. It is not deployed without an exact runtime receipt.
