---
name: challenge
disable-model-invocation: true
description: Ask Kimi to challenge the architecture, assumptions, and failure modes in the current project.
argument-hint: "[specific decision or risk area]"
allowed-tools: mcp__plugin_kimi-relay_relay__start_task, mcp__plugin_kimi-relay_relay__get_task
---

Start a `challenge` task using the project directory already configured on the plugin MCP server. Use `$ARGUMENTS` as the focus and `background: false`, so the call waits and hands back the finished critique in one step; it can take several minutes, and the client backgrounds it on its own rather than blocking the session. Pass `background: true` only when the user wants to come back to it later. When presenting results, distinguish verified defects from speculative risks.

Pass `model` or `thinkingEffort` only when the user named one themselves. Never infer either from the repository or from what seems appropriate — the point of a second opinion is that you did not choose how it was produced.
