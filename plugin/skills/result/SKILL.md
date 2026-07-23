---
name: result
disable-model-invocation: true
description: Retrieve and evaluate the final result of a Kimi task.
argument-hint: "<task-id>"
allowed-tools: mcp__plugin_kimi-relay_relay__get_task
---

Call `get_task`. If incomplete, report the current status. If completed, summarize the result, warnings, and patch location. Treat Kimi's output as an independent review, not as automatically correct.
