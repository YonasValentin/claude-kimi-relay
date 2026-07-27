---
name: challenge
disable-model-invocation: true
description: Ask Kimi to challenge the architecture, assumptions, and failure modes in the current project.
argument-hint: "[specific decision or risk area]"
allowed-tools: mcp__plugin_kimi-relay_relay__start_task, mcp__plugin_kimi-relay_relay__get_task
---

Start a `challenge` task using the project directory already configured on the plugin MCP server. Use `$ARGUMENTS` as the focus, run it in the background, and return the task ID. When presenting results, distinguish verified defects from speculative risks.

Pass `model` or `thinkingEffort` only when the user named one themselves. Never infer either from the repository or from what seems appropriate — the point of a second opinion is that you did not choose how it was produced.
