---
name: status
disable-model-invocation: true
description: Show status for a Kimi task or list recent Kimi tasks.
argument-hint: "[task-id]"
allowed-tools: mcp__plugin_kimi-relay_relay__get_task, mcp__plugin_kimi-relay_relay__list_tasks
---

When a task ID is supplied, call `get_task`. Otherwise call `list_tasks` with limit 10. Show status, recent events, and any error. Do not expose internal process IDs.
