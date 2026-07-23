# Threat model

## Protected assets

- The original project checkout and its Git history.
- Credentials and sensitive files on the developer machine.
- Package registries, deployment targets, and remote Git repositories.
- Integrity of task records and generated patches.

## Boundaries

- Claude Code communicates with the bundled local MCP server over stdio.
- The relay launches `kimi acp` as the current operating-system user.
- Kimi works in a fresh isolated two-commit repository or filtered snapshot, never the original project directory or original Git history.
- ACP filesystem requests pass through canonical path, symlink, size, and secret-path checks.
- Tool permission requests pass through a deny-first policy.

## Controls

- No shell interpolation; subprocesses receive argument arrays with `shell: false`.
- Base and current working states are copied through a sensitive-path and symlink filter into a new local Git history before Kimi starts.
- Delegate output is a binary Git patch relative to that baseline.
- Publishing, pushes, commits, dependency installation, network utilities, privilege escalation, and common credential paths are denied by default.
- Task JSON updates use atomic replacement and per-task cross-process locks.
- Kimi inherits a small environment allowlist, with credentials stripped from any forwarded proxy URL.
- Copied symlinks are rewritten to workspace-relative targets, and the agent runs in its own process group so termination reaches any helper it spawned.

## Residual risks

This is not an OS sandbox. A sufficiently creative command executed by the current user can bypass string-based command policy or access files available to that user. Malicious repositories can also execute code through existing project scripts. The sensitive-path filter is a best-effort denylist of known credential shapes; a secret with an opaque name (for example a service-account key named after its project) can still be copied into the workspace. Use a disposable VM or container with restricted mounts and networking for untrusted repositories or high-value source code.
