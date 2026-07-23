# Security policy

## Security model

Claude Kimi Relay assumes that a local coding agent is powerful and fallible. It therefore:

- creates a new isolated two-commit repository for every Git task without copying the original Git history;
- filters sensitive paths and unsafe symlinks from both snapshots;
- records the user's existing work as the current baseline and returns only later Kimi changes;
- never lets Kimi edit the original project directly;
- mediates ACP file reads and writes with canonical path, symlink, size, and secret-path checks;
- applies a deny-first permission policy to review tasks and a restricted policy to delegate tasks;
- denies common credential access, remote Git writes, commits, publishing, dependency installation, network utilities, deployment, privilege escalation, and destructive commands;
- sanitizes the environment inherited by the Kimi process;
- returns implementation work as a patch requiring explicit review and application;
- bounds copied files, workspace size, command output, stderr diagnostics, and model output;
- stores task data with user-only filesystem permissions where supported;
- serializes concurrent updates with atomic replacement and cross-process lock files.

## Important limitation

The isolated repository is not a full operating-system sandbox. Kimi Code runs as the current OS user, and Kimi's local shell execution is governed by its permission flow plus this relay's string- and metadata-based policy. A sufficiently creative command or malicious project script may bypass those controls and access resources available to the current user.

For untrusted repositories or highly sensitive machines, run the relay inside a disposable VM or container with restricted mounts, credentials, and networking.

See [THREAT_MODEL.md](./THREAT_MODEL.md) for the detailed trust boundaries and residual risks.

## Supported versions

Only the latest minor release is supported during the pre-1.0 period.

## Reporting a vulnerability

Do not open a public issue for an exploitable vulnerability. Report it through [GitHub private vulnerability reporting](https://github.com/YonasValentin/claude-kimi-relay/security/advisories/new). Include reproduction steps, affected versions, and expected impact. Expect an acknowledgement within a few days.
