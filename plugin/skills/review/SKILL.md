---
name: review
disable-model-invocation: true
description: Ask Kimi to perform an independent read-oriented code review of the current project.
argument-hint: "[focus or --base ref]"
allowed-tools: mcp__plugin_kimi-relay_relay__start_task, mcp__plugin_kimi-relay_relay__get_task
---

Start a `review` task using the project directory already configured on the plugin MCP server.

- `prompt`: use `$ARGUMENTS`, or "Review the current changes for material defects" when empty
- `background`: `true` unless the user explicitly asks for a foreground result
- `baseRef`: parse `--base <ref>` from `$ARGUMENTS` when present; otherwise `HEAD`

Return the task ID. When the user asks for the result, call `get_task`, summarize Kimi's findings, and independently sanity-check high-severity claims before presenting them as facts.
