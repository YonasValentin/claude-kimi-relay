# Changelog

All notable changes follow Keep a Changelog. This project uses Semantic Versioning.

## [Unreleased]

### Added

- Every completed task now reports what produced it, under `result.agentConfig`: the agent's name and version from the ACP `initialize` response, and its session configuration options — model, reasoning level, mode — exactly as the agent reported them on `session/new`. A change the agent makes mid-run is folded in and flagged with `changedDuringRun`. There is deliberately no `model` field: the relay reports the agent's own option ids and values rather than claiming to know which one is the model, and an agent that advertises no configuration yields no options rather than a guess.
- A task can request a `model` and a `thinkingEffort`, on `start_task` and as `--model` / `--thinking-effort` on the CLI. The value is matched against the options the agent advertises for that session and is never sent to it as a raw string, so the relay's outbound configuration is always a subset of what the agent offered. The model is applied before the effort, because choosing a model can rewrite the reasoning scale or remove it — a request the agent cannot honour becomes a warning and the task runs at the agent's own default rather than failing. Both values are persisted on the task record, so they survive the detached worker that executes background tasks.
- `agentConfig.envOverrides` names — never values — the forwarded `KIMI_MODEL_*` and `KIMI_CODE_HOME` variables that Kimi's documentation says can override which model answers, how hard it reasons, which endpoint receives the request, or where its configuration lives. It is the first place to look when a task ignored what was asked of it.

### Security

- Upgraded the dev toolchain to clear GHSA-mh99-v99m-4gvg (`brace-expansion` denial of service, reachable through `minimatch` under ESLint and c8): `eslint` 9 → 10, `eslint-plugin-security` 3 → 4, `c8` 10 → 12. Nothing shipped in the package was affected, since it publishes only `dist/` and documentation. An npm `override` was tried first and rejected: `brace-expansion` 5.0.8 is the only unaffected release, no backport exists for the 1.x or 2.x lines `minimatch` depends on, and forcing 5.x onto them breaks their CommonJS entry point on any pattern containing braces. No lint rule changed and no source edit was needed.

### Fixed

- Task-lock contention on Windows is waited on instead of thrown. `open(path, "wx")` answers EEXIST on POSIX, but Windows also answers EPERM, EACCES or EBUSY when the lock file is open elsewhere or pending deletion -- a file marked for delete stays visible until its last handle closes. The retry loop treated anything but EEXIST as fatal, so a task update failed outright rather than waiting its turn. Reachable in production whenever the MCP server and a background worker touch the same task; it surfaced first as an intermittently red Windows CI leg.
- `doctor` checked Kimi with the relay's full environment while the ACP spawn sanitizes it, so a green tick could reflect a variable the real task never sees. The Kimi check now uses the same restricted environment and says so. Git deliberately keeps the full environment: it is a host diagnostic.
- Errors raised inside the ACP protocol were re-wrapped as a generic `KIMI_ACP_FAILED`, discarding the specific code and message — the sign-in instructions for an unauthenticated agent, the versions to align on a protocol mismatch, the result-size limit. They now reach the caller intact.
- `KIMI_EXITED` reported an exit code and discarded the agent's stderr, which is the only place a dying agent explains itself.

### Changed

- The review skill no longer tells Claude to fall back to `baseRef: HEAD`, which suppressed the merge-base auto-selection added in 0.2.0 and put the empty-diff case back on the table.
- THREAT_MODEL.md and README.md now document the `KIMI_*` environment channel that the allowlist has always forwarded.

## [0.2.0] - 2026-07-24

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
