# Tabellio Buildkite Bootstrap

The Buildkite pipeline configuration lives at `.buildkite/pipeline.yml`.
Buildkite's configured bootstrap command is `buildkite-agent pipeline upload`,
which loads that file for every branch and pull-request build.

This bootstrap pins its Node runtime through `.mise.toml` and intentionally
runs the repository's existing `npm run check` only. It has no deployment,
provider, release, or production-data credentials. Future delivery-validation
steps must remain bounded, exact-head, and separately reviewed.

## Local validation

```bash
bk pipeline validate .buildkite/pipeline.yml
npm run check
```
