# Changelog

All notable changes follow Keep a Changelog. This project uses Semantic Versioning.

## [Unreleased]

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
