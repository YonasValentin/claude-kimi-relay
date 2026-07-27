# Threat model

## Protected assets

- The original project checkout and its Git history.
- Credentials and sensitive files on the developer machine.
- Package registries, deployment targets, and remote Git repositories.
- Integrity of task records and generated patches.
- Integrity of the second opinion: which agent, model, and reasoning level produced a result.
- The developer's Kimi account quota and spend.

## Boundaries

- Claude Code communicates with the bundled local MCP server over stdio.
- The relay launches `kimi acp` as the current operating-system user.
- Kimi works in a fresh isolated two-commit repository or filtered snapshot, never the original project directory or original Git history.
- ACP filesystem requests pass through canonical path, symlink, size, and secret-path checks.
- Tool permission requests pass through a deny-first policy — for the tool calls the agent chooses to ask about. Whether it asks is the agent's decision, not the relay's.

## Controls

- No shell interpolation; subprocesses receive argument arrays with `shell: false`.
- Base and current working states are copied through a sensitive-path and symlink filter into a new local Git history before Kimi starts.
- Delegate output is a binary Git patch relative to that baseline.
- Publishing, pushes, commits, dependency installation, network utilities, privilege escalation, and common credential paths are denied by default.
- Task JSON updates use atomic replacement and per-task cross-process locks.
- Kimi inherits an environment allowlist, with credentials stripped from any forwarded proxy URL. The allowlist matches by prefix and deliberately includes Kimi's own `KIMI_*` and `MOONSHOT_*` families, because that is how a developer points Kimi at their own provider. Per Kimi's documentation those variables can change which model answers (`KIMI_MODEL_NAME`), which reasoning level it uses (`KIMI_MODEL_THINKING_EFFORT`, which bypasses the model's declared effort levels), which endpoint receives the request (`KIMI_MODEL_BASE_URL`), which credential is used (`KIMI_MODEL_API_KEY`), and where Kimi's config, sessions, logs, and OAuth credentials live (`KIMI_CODE_HOME`). They are read from the environment the relay itself was started in, not from anything a task can supply.
- Copied symlinks are rewritten to workspace-relative targets, and the agent runs in its own process group so termination reaches any helper it spawned.
- Tool calls the relay was never asked to approve are counted and reported on the result. The relay cannot force an agent to ask: Kimi's `auto` and `yolo` session modes stop sending permission requests entirely — its own documentation calls that "those modes' explicit contract" — and the mode can be preset with `default_permission_mode` in the user's `~/.kimi-code/config.toml`, which every relayed session inherits. So the control here is detection, not prevention, and it is deliberately agent-agnostic: it compares the number of announced tool calls against the number of approval requests, rather than relying on any agent's mode names.
- A caller-requested model or reasoning level is used only as a lookup key against the options the agent advertised for that session. The relay never sends a caller-supplied string as a configuration value, never offers a general way to set arbitrary agent options, and never advertises the boolean session-configuration capability. What actually ran is reported on the result.

## Residual risks

A per-task model or reasoning-level request originates from Claude, and Claude reads the repository under review. A file in that repository can therefore try to talk Claude into asking for a cheaper model or thinking turned off, and the answer would come back looking like any other review. Restricting the request to values the agent already advertised bounds what can be asked for, but it does not stop a legitimate value being requested for an illegitimate reason. The control is that the effective configuration is always reported, not that it cannot be changed — so read `agentConfig` before weighing a result you did not configure yourself.

This is not an OS sandbox. A sufficiently creative command executed by the current user can bypass string-based command policy or access files available to that user. Malicious repositories can also execute code through existing project scripts. The sensitive-path filter is a best-effort denylist of known credential shapes; a secret with an opaque name (for example a service-account key named after its project) can still be copied into the workspace. Use a disposable VM or container with restricted mounts and networking for untrusted repositories or high-value source code.
