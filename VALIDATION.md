# Validation status

Last validated on 2026-07-23 on macOS (arm64) with Node.js 24.18, Git 2.50, Claude Code (latest), and an authenticated Kimi Code CLI 0.29.0.

A security and correctness audit was applied on 2026-07-23 (see the CHANGELOG hardening entries). On the merged `main`, `npm run verify` passes with **30 test cases** (up from 16), the committed `plugin/dist` matches a fresh build, and a live `review -> delegate -> apply` round-trip against `kimi acp` 0.29.0 completed correctly with the original working tree untouched in every mode. The live runs exercised the happy path, workspace isolation, and the patch boundary on macOS; the Windows process-group termination path and adversarial deny paths are covered by unit tests rather than live runs.

## Passed on the release machine

- `npm install` with a committed `package-lock.json`; `npm audit` reports **0 vulnerabilities** (an npm `override` pins `@hono/node-server` to `^2.0.11` because the relay only uses MCP stdio transport, and SDK 1.29's `^1.19.9` range is flagged by GHSA-frvp-7c67-39w9; the 2.x exports used by the SDK, `serve` and `getRequestListener`, are unchanged).
- `npm run verify` — Prettier, ESLint (`strictTypeChecked` + `eslint-plugin-security`, zero warnings), strict `tsc --noEmit`, **16 Node test cases passed with 0 failures**, and a clean `tsc` + esbuild plugin bundle build.
- Permission-policy tests for review writes, publication, network tools, dependency installation, and commits.
- Filesystem tests for lexical traversal, symlink escape, secret paths, safe nested writes, and absolute paths through a symlinked workspace root (for example `/tmp` on macOS).
- Persistence tests for atomic writes and concurrent updates.
- Workspace tests for user-change baselining, Kimi-only patch generation, sensitive-file exclusion, and removal of original Git history.
- `claude plugin validate ./plugin --strict` and `claude plugin validate . --strict` — both passed.
- `npm pack --dry-run` — tarball contains only `dist/` and release documentation.
- GitHub Actions CI — the full `npm run verify` pipeline plus `npm pack --dry-run` and the plugin-bundle check passed on Ubuntu, macOS, and Windows against Node.js 22 and 24. Windows required a `.gitattributes` `eol=lf` rule, because runners check out with `core.autocrlf=true` and Prettier's default `endOfLine: "lf"` then rejects every file.
- Live MCP smoke test over stdio: `tools/list`, schema shape checks, `doctor`, `start_task`, `get_task`, `list_tasks`, `cancel_task`.
- Live end-to-end ACP smoke test against an authenticated `kimi acp`: a background `review` task transitioned `queued → preparing_workspace → starting_agent → running → validating → completed` and returned a correct textual result; review mode modified no files.

## Still required before public release

1. **One-time, on npmjs.com (manual, cannot be automated):** configure this repository as a Trusted Publisher for the `claude-kimi-relay` package — package settings → Trusted Publishers → GitHub Actions, repository `YonasValentin/claude-kimi-relay`, workflow `release.yml`. Without it the release workflow's OIDC `npm publish` has no credential.
2. Tag `v0.1.0` and push it; `release.yml` runs `release:check` + `verify`, then publishes with Sigstore provenance. Verify provenance on npm afterward.

The npm package name `claude-kimi-relay` is available, the version is consistent across `package.json` and both plugin manifests (gated by `release:check`), `package-lock.json` and `plugin/dist` are committed, and `npm pack --dry-run` ships only `dist/` and release documentation. Until the tag is pushed, the repository remains release-candidate source, not a published or vendor-endorsed integration.
