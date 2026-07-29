# INTB-261 P8 execution contract

## Outcome

Operators can join delivery evidence and render a decision-grade Markdown
check-in without dropping deployment receipts, overwriting source evidence, or
allowing evidence text to alter report structure.

## Required outcomes

- The delivery CLI forwards validated deployment receipts and blocked
  collection evidence into the v0.2 delivery snapshot.
- The delivery and report CLIs keep their outputs distinct from every input,
  including filesystem aliases.
- Reports expose unlinked delivery rows and every non-passed CI decision as
  evidence gaps.
- Source reasons and record identifiers are escaped before Markdown rendering.

## Invariants

- The designated Buildkite organization and pipeline remain explicit inputs.
- Joined snapshots pass the v0.2 delivery evidence validator.
- GitHub Release shipping truth stays distinct from runtime deployment proof.
- Validation uses no provider writes, paid calls, or live deployment actions.

## Forbidden outcomes

- A deployment receipt is accepted but omitted from the joined snapshot.
- An output truncates or overwrites any evidence input.
- Markdown or HTML-shaped evidence changes report structure.
- Failed, missing, or unlinked evidence is reported as healthy.

## Required validators

Static, schema, semantic, workflow, operational, and security validators must
pass on the exact candidate commit with complete zero-cost telemetry.
