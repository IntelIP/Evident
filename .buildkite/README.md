# Tabellio self-hosted Buildkite CI

Buildkite remains the control plane. A locally managed agent executes every
substantive step inside a pinned Node 24 Alpine container on the shared
current-project queue.

The container installs and verifies Git against Tabellio's supported contract
without consuming hosted M4 capacity. Every run is manual, exact-commit,
lease-gated, limited to one current-project job at a time, and has manual
retries disabled. The queue stays paused outside an explicitly approved run.

GitHub remains source, review, merge, and merged-head validation authority.
No pipeline step deploys, publishes, queries a paid provider, or receives
production credentials.

## Local checks

```bash
bk pipeline validate --file .buildkite/pipeline.yml
npm run check
```

Explicit Buildkite builds must set:

```text
INTELIP_CI_LEASE_ID=<approved-lease>
TABELLIO_BUILD_CONTEXT=preflight
TABELLIO_BASE_BRANCH=main
```
