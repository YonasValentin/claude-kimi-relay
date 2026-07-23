---
name: delegate
disable-model-invocation: true
description: Delegate an implementation task to Kimi inside an isolated repository copy and return a reviewable patch.
argument-hint: "<implementation task>"
allowed-tools: mcp__plugin_kimi-relay_relay__start_task, mcp__plugin_kimi-relay_relay__get_task
---

Start a `delegate` task using the project directory already configured on the plugin MCP server, `$ARGUMENTS` as the complete task, and `background: true`. Explain that Kimi cannot modify the original repository directly; completion produces a patch that must be reviewed and explicitly applied.
