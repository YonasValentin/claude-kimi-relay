# Releasing

Releases publish to npm from a version tag, with Sigstore provenance, via
[`.github/workflows/release.yml`](./.github/workflows/release.yml). Publishing
uses npm Trusted Publishing (GitHub OIDC) — no long-lived `NPM_TOKEN`, and no
one-time password prompt.

## One-time setup on npmjs.com

Configure this repository as a Trusted Publisher for the package (required
before the first CI publish; a tag push still runs CI without it, but the
publish step needs it):

1. npmjs.com → the `claude-kimi-relay` package → **Settings → Trusted Publishers → Add → GitHub Actions**.
2. Fill in:
   - **Organization or user:** `YonasValentin`
   - **Repository:** `claude-kimi-relay`
   - **Workflow filename:** `release.yml`
   - **Environment:** leave blank

`v0.1.0` was published manually from a workstation, so it carries no
provenance. Every version cut through the flow below does.

## Cutting a release

```bash
node scripts/bump-version.mjs 0.1.1   # sets the version in package.json + both
                                      # plugin manifests and rebuilds plugin/dist
npm run verify                        # format, lint, strict tsc, tests, builds
git commit -am "release: v0.1.1"
git tag v0.1.1 && git push --follow-tags
```

On the tag, `release.yml`:

1. upgrades to npm ≥ 11.5 (older npm publishes unauthenticated over OIDC),
2. runs `release:check` (asserts the tag, `package.json`, and both plugin
   manifests all agree) and `npm run verify`,
3. publishes with `npm publish --provenance --access public`, skipping if that
   version is already on npm.

Afterward, confirm the provenance badge on the npm package page.

## Versioning

Semantic Versioning. `release:check` fails the release if the tag, the npm
package version, and the two plugin manifest versions are not identical, so use
`scripts/bump-version.mjs` rather than editing the files by hand.
