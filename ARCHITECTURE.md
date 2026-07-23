# Architecture

```text
Claude Code plugin
  └─ bundled MCP server (stdio)
       └─ TaskService + atomic JSON task store
            └─ detached worker for background tasks
                 ├─ isolated Git clone / directory snapshot
                 ├─ ACP client
                 │    └─ `kimi acp` subprocess
                 └─ result + optional patch artifact
```

## Trust boundaries

1. **Original project:** never mounted as Kimi's working directory.
2. **Isolated workspace:** disposable copy where Kimi operates.
3. **ACP filesystem bridge:** canonical path and symlink containment checks.
4. **Permission broker:** deny-first policy for review; restricted mutation policy for delegate.
5. **Patch boundary:** generated changes do not enter the original repository until a human or Claude explicitly applies the patch.

## Persistence

Each task is stored as one atomically replaced JSON file under the plugin data directory. This avoids native database dependencies and supports recovery across Claude Code restarts. Background tasks run in detached worker processes and persist progress events.
