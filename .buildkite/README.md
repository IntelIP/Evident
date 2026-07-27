# Tabellio Buildkite CI

Buildkite runs the repository check on every build. Pull-request builds also
run changed-code Fallow, package inspection, and exact-head product validation.
The product-validation step exports the Git validation ref as a portable bundle
instead of treating an internal `.git` ref as a workspace artifact.

GitHub remains the source, pull-request, review, and merge authority. Existing
GitHub Actions remain active for merged-head product validation and quality
checks until Buildkite proves equivalent commit-to-pull-request association.

## Local checks

```bash
bk pipeline validate
npm run check
```

No Buildkite step deploys, publishes, or receives production provider
credentials. Pull requests from third-party forks remain disabled during the
migration.
