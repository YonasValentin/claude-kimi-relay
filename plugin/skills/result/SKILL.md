---
name: result
disable-model-invocation: true
description: Retrieve and evaluate the final result of a Kimi task.
argument-hint: "<task-id>"
allowed-tools: mcp__plugin_kimi-relay_relay__get_task
---

Call `get_task`. If incomplete, report the current status. If completed, summarize the result, warnings, and patch location. Treat Kimi's output as an independent review, not as automatically correct.

When `result.agentConfig` is present, state which agent, model, and reasoning level produced the result — that is part of how much weight it deserves. Report `agentConfig.summary` verbatim rather than paraphrasing it; the values are the agent's own, and the relay does not claim to know which of them is "the model". Mention `changedDuringRun` if set, and name any `envOverrides`, since those explain a session that ignored what was asked of it.
