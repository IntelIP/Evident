# Tabellio Buildkite CI

Buildkite runs tests, changed-code analysis, package inspection, and exact-head
product validation. GitHub remains the source, pull-request, review, and merge
authority.

## Local checks

```bash
bk pipeline validate
npm run check
```

No Buildkite step receives deployment or provider credentials. Pull requests
from third-party forks stay disabled during migration.

GitHub Actions have been removed. GitHub requires the `buildkite/tabellio`
status on `main`; the status must pass on the exact pull-request head.
