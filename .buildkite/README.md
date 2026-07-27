# Tabellio Buildkite CI

Buildkite runs repository checks on pull requests and the default branch.
Pull-request builds also run changed-code Fallow, package inspection, and
exact-head product validation.
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

When the GitHub integration does not emit a synchronized pull-request build,
start an explicit exact-head preflight:

```bash
bk build create -y \
  -p intelip/tabellio \
  -b codex/example \
  -c <exact-sha> \
  -e TABELLIO_BUILD_CONTEXT=preflight \
  -e TABELLIO_BASE_BRANCH=main
```

No Buildkite step deploys, publishes, or receives production provider
credentials. Pull requests from third-party forks remain disabled during the
migration.
