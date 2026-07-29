# INTB-261-cross-repository-baseline

Observed: 2026-07-29T01:08:22.000Z
Window: 2026-07-01T00:00:00.000Z to 2026-07-29T01:08:21.000Z
Dataset digest: `8f8071c5797af2c38abea8d81785bff259f9f42ab347ffe535c29e3c5b7fb9d5`

## Interpretation boundary

Repository rows describe evidence coverage and delivery-system behavior. They do not rank developers or infer user value from activity volume.

## Repository baseline

| Repository | Head | Changes | Traceability | Lead time | Cycle time | CI disagreement | Release lag |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| IntelIP/Condere | `4ec36ff4ba24` | unknown | unknown | unknown | unknown | unknown | unknown |
| IntelIP/Probanda | `e354f0647f87` | unknown | unknown | unknown | unknown | unknown | unknown |
| IntelIP/Tabellio | `588f394f5603` | 1 | 100.0% | unknown | 0.04 h | unknown | unknown |
| IntelIP/vaticor | `f09f23fa8a0e` | unknown | unknown | unknown | unknown | unknown | unknown |

## Delivery change trace

| Repository | Change | Plane | PR | Head | Exact validation | Hosted CI | Merged | Released |
| --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| IntelIP/Tabellio | tabellio-pr-42 | INTB-261 | 42 | `588f394f5603` | unavailable | passed | 2026-07-29T01:05:49.000Z | unknown |

## Missing evidence

### IntelIP/Condere

- tabellio-validation: blocked — Control evidence is malformed or unsafe.
- tabellio-review: unavailable — Control evidence is unavailable.
- plane: unavailable — Provider evidence was not collected for this baseline.
- github: unavailable — Provider evidence was not collected for this baseline.
- github-actions: unavailable — Provider evidence was not collected for this baseline.
- buildkite: unavailable — Provider evidence was not collected for this baseline.

### IntelIP/Probanda

- tabellio-validation: blocked — Control evidence is malformed or unsafe.
- tabellio-review: unavailable — Control evidence is unavailable.
- plane: unavailable — Provider evidence was not collected for this baseline.
- github: unavailable — Provider evidence was not collected for this baseline.
- github-actions: unavailable — Provider evidence was not collected for this baseline.
- buildkite: unavailable — Provider evidence was not collected for this baseline.

### IntelIP/Tabellio

- tabellio-validation: blocked — Control evidence is malformed or unsafe.
- tabellio-review: blocked — Control evidence is malformed or unsafe.

### IntelIP/vaticor

- tabellio-validation: blocked — Control evidence is malformed or unsafe.
- tabellio-review: unavailable — Control evidence is unavailable.
- plane: unavailable — Provider evidence was not collected for this baseline.
- github: unavailable — Provider evidence was not collected for this baseline.
- github-actions: unavailable — Provider evidence was not collected for this baseline.
- buildkite: unavailable — Provider evidence was not collected for this baseline.

## Metric definitions

- `deliveryChangeCount` (count)
- `taskToPrTraceability` (ratio)
- `leadTimeHours` (hours)
- `cycleTimeHours` (hours)
- `ciDisagreementRate` (ratio)
- `releaseLagHours` (hours)

## Provenance

### IntelIP/Condere

- HEAD: `4ec36ff4ba24cfd4a92c525b77a0027a001033e9` at 2026-07-21T17:35:01.000Z
- git: available; version 4ec36ff4ba24cfd4a92c525b77a0027a001033e9; digest 1046df76b5d67ba084699ef959fa871705052f1c6d3c86f425439c3de3e4abdb
- tabellio-validation: blocked; version unknown; digest unavailable
- tabellio-review: unavailable; version unknown; digest unavailable
- entire: available; version 8a31aa17b25cde2653c1f18dfdd7d0e380099173; digest 769f3f75f2cc65527c21e2d7e5d53677f28d33e406cf479c86fe73d19be4be94
- plane: unavailable; version unknown; digest unavailable
- github: unavailable; version unknown; digest unavailable
- github-actions: unavailable; version unknown; digest unavailable
- buildkite: unavailable; version unknown; digest unavailable

### IntelIP/Probanda

- HEAD: `e354f0647f879637dd1ccf9d63d38b735177fbdd` at 2026-07-23T18:04:11.000Z
- git: available; version e354f0647f879637dd1ccf9d63d38b735177fbdd; digest 05a835eeb3bd8c5160e9f5ddfdea494eab8911e4dce04c0bd91c3dab3a1d784a
- tabellio-validation: blocked; version unknown; digest unavailable
- tabellio-review: unavailable; version unknown; digest unavailable
- entire: available; version ae293ab234789fdbf881378ac6dbf04069bd56e4; digest 3301dabdfac50586bbd5e930c43f444a62a2da7b6ec44b9a14e7a1b1ed0a43e5
- plane: unavailable; version unknown; digest unavailable
- github: unavailable; version unknown; digest unavailable
- github-actions: unavailable; version unknown; digest unavailable
- buildkite: unavailable; version unknown; digest unavailable

### IntelIP/Tabellio

- HEAD: `588f394f5603cacc23dc0d6a794966e08eae17ac` at 2026-07-29T01:05:49.000Z
- git: available; version 588f394f5603cacc23dc0d6a794966e08eae17ac; digest f4bf60b194ccef1c0d802f1b0748013cd5f76a373fc29a0bac3f2612d2a3c877
- tabellio-validation: blocked; version unknown; digest unavailable
- tabellio-review: blocked; version unknown; digest unavailable
- entire: available; version dff2929830ef29056062b4f01610e547b745acf0; digest 75feb544ec29d00eae4c5c2293e2204fcb28b22458b28bd505caf04364c4003b
- plane: available; version 2026-07-29T01:04:00.000Z; digest 504a02f5284fcaaefc0979f98808d387e835a102088c861b0c3491e276707c75
- github: available; version 2026-07-29T01:05:49.000Z; digest 9b152d68bc0d3a6224a792a24ca171a1f013dd5747c8037213491a3a602ecaa6
- github-actions: available; version 2026-07-29T01:04:13.000Z; digest 4430bce8cd6d93eea8f80772abafad6e420dac492c4751360365998d0ce2812d
- buildkite: available; version 2026-07-29T01:05:35.000Z; digest 26cafb4f7d83270705af4c73a01df6eccdf2662995e8447d7de1be6cec8864aa

### IntelIP/vaticor

- HEAD: `f09f23fa8a0ef45963bef5360f482994dac68521` at 2026-07-28T16:21:15.000Z
- git: available; version f09f23fa8a0ef45963bef5360f482994dac68521; digest 3b3075e6add8f36cce92ee1182b96d5ac2af22b26a809f8ae413698a2512b46a
- tabellio-validation: blocked; version unknown; digest unavailable
- tabellio-review: unavailable; version unknown; digest unavailable
- entire: available; version a162aa6361c46a479dd180bcab687d0a4fff55c7; digest 2be04575c0738e9588ac5559b2704867ab558621c66f816496c727527e41a38c
- plane: unavailable; version unknown; digest unavailable
- github: unavailable; version unknown; digest unavailable
- github-actions: unavailable; version unknown; digest unavailable
- buildkite: unavailable; version unknown; digest unavailable
