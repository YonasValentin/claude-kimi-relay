# Validation status

Last validated on 2026-07-23 on macOS (arm64) with Node.js 22.16, npm 10.9, Git 2.50, Claude Code (latest), and an authenticated Kimi Code CLI 0.29.0.

## Passed on the release machine

- `npm install` with a committed `package-lock.json`; `npm audit` reports **0 vulnerabilities** (an npm `override` pins `@hono/node-server` to `^2.0.11` because the relay only uses MCP stdio transport, and SDK 1.29's `^1.19.9` range is flagged by GHSA-frvp-7c67-39w9; the 2.x exports used by the SDK, `serve` and `getRequestListener`, are unchanged).
- `npm run verify` — Prettier, ESLint (`strictTypeChecked` + `eslint-plugin-security`, zero warnings), strict `tsc --noEmit`, **14 Node test cases passed with 0 failures**, and a clean `tsc` + esbuild plugin bundle build.
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

The following depend on decisions or accounts outside the codebase:

1. Confirm the npm package name and marketplace name are available.
2. Configure npm Trusted Publishing for `.github/workflows/release.yml` (GitHub Actions OIDC, no long-lived npm token).
3. Commit `package-lock.json` and the generated `plugin/dist` bundle in the release revision.
4. Tag `v0.1.0` and verify npm provenance after publication.

The repository is release-candidate source, not a published or vendor-endorsed integration.
