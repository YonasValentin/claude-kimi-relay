# Changelog

All notable changes follow Keep a Changelog. This project uses Semantic Versioning.

## [Unreleased]

### Security

- Permission broker no longer selects a session-wide `allow_always` ACP option: it prefers the one-shot allow (and refuses to allow when only an `always` option is offered), and symmetrically prefers `reject_once`. A conforming agent records `allow_always` as a persistent grant and stops re-requesting, so selecting it after one benign call would have bypassed the deny-first gate for the rest of the session.
- Review/challenge mode is stricter about commands that write through a safe-read verb: a shell redirection/append/pipe/chain/substitution operator (`>` `>>` `|` `;` `&` `` ` `` `$(`) or an embedded newline is treated as mutating, as are writer binaries (`tee`, `cp`, `mv`, `rm`, `rmdir`, `mkfifo`) and `find` write/exec actions (`-exec`, `-delete`, `-fprint`, …). This is best-effort defense-in-depth over a string policy, not a sandbox — untrusted repositories still warrant OS-level isolation, as THREAT_MODEL.md notes.

### Added

- `review`/`challenge` started without an explicit `baseRef` now auto-select the merge-base with the branch's upstream, so "review my work" compares real changes instead of an empty `HEAD..HEAD`. The auto-selected base is reported in a warning and is never silent; with no upstream configured it falls back to the current tree (and the empty-diff warning fires). Applies through the MCP `start_task` tool and the CLI `--base` flag, which previously defaulted to `HEAD` and suppressed the auto-selection. Pass an explicit `baseRef` to override. `delegate` still diffs against the current tree.
- Long-running tasks emit a periodic liveness event ("Still analyzing — N updates so far, Ms elapsed") whenever Kimi goes a while with no progress update, so a `get_task` poller can tell a slow-but-working run apart from a hung one. The heartbeat only fires during silent gaps and never while real progress is already flowing.
- Tasks left in a non-terminal state by a crashed server or a hard-killed (SIGKILL/OOM) background worker are reconciled to `failed` at server/CLI startup, using a recorded owner PID (or, for a task still `queued`, the spawned worker PID) to distinguish a dead owner from a detached worker that is still running. Previously such tasks were reported as running or queued forever.

### Fixed

- `review`/`challenge` no longer silently degrade to a whole-tree read while still instructing the reviewer to run `git diff HEAD^ HEAD`. When `baseRef` resolves to the same tree as the current snapshot (the default `HEAD` on a clean checkout), the isolated base and current commits are identical and that diff is empty. The relay now detects the empty diff, replaces the misleading comparison hint with a loud "no changes to review — pass an explicit baseRef" warning, and tells Kimi plainly that the snapshots are identical so it must not attribute any finding as newly introduced versus pre-existing. `delegate` is unaffected (an empty base diff is legitimate there).
- A failed `prepare()` no longer strands a partially-populated `workspaces/<id>` directory, and a `resolveBaseRef` failure no longer leaks a `relay-base-*` staging directory.
- The task event log is capped, so an unbounded progress stream from a hostile repository can no longer grow the record without limit (previously O(n²) cumulative disk writes over a long run). A late heartbeat can no longer append a stale event or regress a task's status after it advances past `running`.
- Reviewing a Git repository with no commits now fails with a clear "no commits to review" message instead of an opaque `git checkout` error.
- `terminate()` no longer leaves a ref'd grace timer pending after the child exits, so a worker process exits promptly instead of lingering for the grace period.
- An out-of-range `CLAUDE_KIMI_RELAY_TIMEOUT_MS` now falls back to the default instead of silently making every default-timeout task fail validation; `doctor` enforces the full Node.js 22.14 floor rather than only the major version.
- The published npm tarball no longer ships dangling source maps (they referenced `src/`, which is not published), and the `release:bump` helper now runs on Windows.

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
