# Wave Admission

Wave admission answers one question before parallel implementation starts:
which lanes are safe to pull now?

The manifest binds each lane to explicit Plane, repository, task, base-commit,
owned-surface, dependency, WIP, and integration-owner evidence. Admission is a
pure local decision. It does not start tasks, update Plane, call providers,
merge, deploy, or release.

## Contract

Use `tabellio-wave-manifest/v0.1` from
`schemas/wave-manifest.v0.1.schema.json`.

A lane is rejected when:

| Code | Meaning |
| --- | --- |
| `LANE_NOT_READY` | Plane state is not exactly `Ready`. |
| `WIP_LIMIT_EXCEEDED` | Existing plus requested WIP exceeds manifest limit, capped at three. |
| `DEPENDENCY_INCOMPLETE` | Declared dependency is not complete. |
| `MAPPING_MISSING` | Plane, repository, and task mapping cannot be resolved. |
| `SURFACE_OVERLAP` | Two lanes claim intersecting surfaces in one repository. |
| `STALE_BASE` | Planned and observed base commits differ. |
| `INTEGRATOR_MISSING` | Final integration owner does not resolve to a mapping. |
| `SURFACE_INVALID` | Owned surface is not a safe repository-relative path or `/**` prefix. |
| `DUPLICATE_IDENTITY` | Mapping, task, lane, or story identity is duplicated. |

Reason ordering and wording are deterministic.

## Demo

```bash
node scripts/tabellio-wave-admit.mjs \
  --manifest examples/tabellio-wave/accepted-three-repository.json

node scripts/tabellio-wave-admit.mjs \
  --manifest examples/tabellio-wave/rejected-overlap-dependency.json
```

First command accepts three independent Ready lanes. Second rejects overlapping
Tabellio surfaces and an incomplete dependency with stable reason codes.

## Boundary

Manifest is snapshot evidence supplied by operator or coordinator. Admission
does not query Plane or Git, and cannot infer links from names or timing.
Callers must build mappings from authoritative identifiers and refresh observed
base commits before each admission decision.
