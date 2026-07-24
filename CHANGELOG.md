# Changelog

All notable changes follow Keep a Changelog. This project uses Semantic Versioning.

## [Unreleased]

### Added

- `review`/`challenge` started without an explicit `baseRef` now auto-select the merge-base with the branch's upstream, so "review my work" compares real changes instead of an empty `HEAD..HEAD`. The auto-selected base is reported in a warning and is never silent; with no upstream configured it falls back to the current tree (and the empty-diff warning fires). Pass an explicit `baseRef` to override. `delegate` still diffs against the current tree.
- Long-running tasks emit a periodic liveness event ("Still analyzing — N updates so far, Ms elapsed") whenever Kimi goes a while with no progress update, so a `get_task` poller can tell a slow-but-working run apart from a hung one. The heartbeat only fires during silent gaps and never while real progress is already flowing.

### Fixed

- `review`/`challenge` no longer silently degrade to a whole-tree read while still instructing the reviewer to run `git diff HEAD^ HEAD`. When `baseRef` resolves to the same tree as the current snapshot (the default `HEAD` on a clean checkout), the isolated base and current commits are identical and that diff is empty. The relay now detects the empty diff, replaces the misleading comparison hint with a loud "no changes to review — pass an explicit baseRef" warning, and tells Kimi plainly that the snapshots are identical so it must not attribute any finding as newly introduced versus pre-existing. `delegate` is unaffected (an empty base diff is legitimate there).

## [0.1.0] - 2026-07-23

### Added

- Claude Code marketplace plugin with setup, review, challenge, delegate, status, result, and cancel skills.
- MCP v1 stdio server and standalone npm CLI.
- Kimi ACP v1 client with permission brokering, cancellation, and streaming results.
- Isolated Git baseline and patch-only implementation workflow.
- Secret-path, symlink, traversal, environment, command, and output protections.
- Persistent background task store with cross-process file locking.
- Cross-platform CI and npm Trusted Publishing workflow.

### Security and robustness hardening

- Permission broker fails closed on a tool-call request too large to inspect, closing a delegate-mode deny-list bypass where padding pushed a denied command past the size cap.
- Sensitive-path filter extended to `*.pem`/`*.key`/keystores, `kubeconfig`, `.pgpass`, `.my.cnf`, and service-account keys; it is documented as a best-effort denylist.
- Isolated-workspace symlinks are rewritten to workspace-relative targets; the agent runs in its own process group so termination reaches the helpers it spawned; proxy-URL credentials are stripped from the forwarded environment.
- Background worker spawn failures are recorded on the task instead of crashing the MCP server; the task lock is fenced with a per-holder token and a liveness-gated steal so a stalled holder cannot be clobbered; foreground tasks are cancelled through an abort signal rather than only marked cancelled.
- CI fails when the committed `plugin/dist` bundle drifts from `src`; the release asserts tag, `package.json`, and plugin-manifest version consistency; GitHub Actions are pinned by commit SHA; `npm audit` gates at moderate.

### Fixed during release-candidate validation

- Relay processes no longer hang after a task finishes. `kimi acp` ignores `SIGTERM`, and the surviving child kept the event loop alive, so every completed task leaked its foreground CLI or detached worker along with its Kimi process. Termination now escalates to `SIGKILL` after a grace period.

- ACP filesystem bridge now accepts absolute paths when the workspace root sits behind a symlink (for example `/tmp` on macOS); containment is decided on canonical paths.
- ACP `initialize` now sends `clientInfo`, verifies the agent-reported protocol version, and reports missing Kimi authentication as a clear error instead of a generic failure.
- Tool schemas advertise field-level descriptions.
- Doctor check enforces the documented Node.js 22.14 minimum.
- Filesystem tests canonicalize temporary roots so they pass on macOS.
- CI installs with `npm ci`; dependency audit is clean through an explicit `@hono/node-server` override (stdio-only transport).
