# Claude Kimi Relay

[![CI](https://github.com/YonasValentin/claude-kimi-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/YonasValentin/claude-kimi-relay/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](./LICENSE)
[![Node.js >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen.svg)](https://nodejs.org)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://prettier.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

A **Claude Code plugin** that keeps Claude as the lead agent and delegates a specific job to **Kimi Code over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP)**: an independent code review, an adversarial critique of a design, or an implementation done in an isolated copy and returned as a Git patch you apply yourself. Kimi never touches your working tree until you say so.

> Independent community project. Not affiliated with or endorsed by Anthropic or Moonshot AI.

## Not the same as pointing Claude Code at Kimi

Moonshot documents a configuration that aims Claude Code's Anthropic-compatible API settings at Kimi. That swaps out the model driving your session, so you end up talking to Kimi instead of Claude.

This does something else. Claude stays in charge and calls Kimi as a second agent when a second opinion is worth having. Two models from two vendors looking at the same code, and the disagreement between them is the useful part.

## How this compares to other Kimi and ACP integrations

Several projects connect Claude Code to a second CLI. They tend to take one of two shapes:

- **Route the model.** Point Claude Code's API base at Kimi so Kimi answers instead of Claude. One model, swapped.
- **Delegate through subagents or an MCP tool.** Hand a prompt to another CLI and read back its text.

This project delegates over ACP and adds an isolation boundary. Before Kimi runs, the relay builds a separate two-commit repository from filtered snapshots, so Kimi sees your code but not your Git history or your credentials. Review and challenge tasks refuse writes. Implementation work comes back as a Git patch that only touches your project when you run `apply`. If you want a second agent on sensitive code without handing it your working tree, that boundary is the point.

## What you get

Inside Claude Code:

- `/kimi-relay:review` reads your current changes or a branch comparison and reports what it finds.
- `/kimi-relay:challenge` goes after the design instead of the code: failure modes, race conditions, rollback behaviour, simpler alternatives you may have skipped.
- `/kimi-relay:delegate` implements something in an isolated copy and hands back a Git patch.
- `/kimi-relay:status`, `/kimi-relay:result`, and `/kimi-relay:cancel` manage background tasks, which survive a Claude Code restart.
- `/kimi-relay:setup` checks your environment.

The same runtime also ships as a `claude-kimi-relay` CLI if you want it outside Claude Code.

## Why a plugin and an npm package

Two distribution layers, because they solve different problems. The Claude Code plugin carries the skills and a bundled MCP server, which is how you get the `/kimi-relay:*` commands. The npm package carries the actual runtime: the CLI, ACP client, permission broker, task store, workspace isolation, and patch workflow. A marketplace plugin is the right way to install something into Claude Code; npm is the right way to version and release a reusable runtime.

## What Kimi can and cannot see

Kimi never gets your project directory or its Git history. Before it starts, the relay builds a throwaway repository somewhere else: one commit holding a filtered snapshot of your base ref, and a second holding your current working state, including changes you have not committed yet. Kimi works on top of that second commit. A delegate patch therefore contains only what Kimi changed, never the work you already had in progress.

Beyond that:

- Review and challenge tasks refuse write permissions outright.
- File reads and writes over ACP resolve to canonical paths and get rejected if they leave the workspace, follow a symlink out of it, exceed the size limit, or point at something that looks like a credential.
- Publishing, pushing, committing, installing dependencies, network tools, `sudo`, and the usual credential paths are denied by default.
- Kimi inherits an allowlist of environment variables rather than your entire environment. The allowlist matches by prefix and deliberately passes Kimi's own `KIMI_*` and `MOONSHOT_*` variables through, since that is how you point Kimi at your own provider — which also means those variables decide which model, reasoning level, endpoint, and credential Kimi uses. See [Pointing Kimi at a different model](#pointing-kimi-at-a-different-model).
- Task files are written atomically behind a cross-process lock, and results, command output, copied files, and workspace size are all bounded.

Now the part that matters more than the list above: this is not an operating-system sandbox. Kimi runs as you, with your permissions. The command policy is string matching, and string matching loses to anyone who genuinely wants around it. A malicious repository can also run code through its own build scripts before any of this applies. If the repository is untrusted, or the machine holds something you cannot afford to lose, run the whole thing inside a VM or container with restricted mounts and no credentials.

Read [SECURITY.md](./SECURITY.md) and [THREAT_MODEL.md](./THREAT_MODEL.md) before pointing delegate mode at anything sensitive.

## Requirements

- Node.js 22.14 or newer (Node 22 or 24 LTS)
- Git
- Kimi Code CLI, installed and authenticated
- Claude Code, if you want the plugin rather than the CLI

Check Kimi works before anything else, since an unauthenticated CLI is the most common reason a task fails:

```bash
kimi --version
kimi
```

## Install

From the marketplace:

```text
/plugin marketplace add YonasValentin/claude-kimi-relay
/plugin install kimi-relay@claude-kimi-relay
/reload-plugins
/kimi-relay:setup
```

Claude Code copies marketplace plugins into its own cache, so every runtime file the plugin needs has to live inside `plugin/` in the published revision. That is why `plugin/dist` is committed rather than gitignored.

Or as a standalone CLI:

```bash
npm install --global claude-kimi-relay
claude-kimi-relay doctor
```

## Using it

In Claude Code:

```text
/kimi-relay:review review the current changes
/kimi-relay:review --base main focus on regressions and security
/kimi-relay:challenge challenge the retry and rollback design
/kimi-relay:delegate fix the failing integration test with the smallest safe patch
/kimi-relay:status
/kimi-relay:result <task-id>
/kimi-relay:cancel <task-id>
```

For `review` and `challenge`, the base ref decides what "the changes" means. Pass an explicit `--base` (the PR target branch, or a merge-base) to review a real change set. With no `--base`, the relay auto-selects the merge-base with your branch's upstream; if there is no upstream it falls back to the current tree, warns that there are no changes to review, and inspects the whole tree instead. `delegate` always builds its patch against the current tree, so it ignores the base ref.

From the CLI, a review that blocks until it finishes:

```bash
claude-kimi-relay start \
  --kind review \
  --project . \
  --prompt "Review the current changes for correctness and security"
```

An implementation that runs in the background:

```bash
claude-kimi-relay start \
  --kind delegate \
  --project . \
  --background \
  --prompt "Fix the failing test with the smallest safe patch"
```

Then read it, and apply it only if you agree with it:

```bash
claude-kimi-relay status <task-id>
claude-kimi-relay result <task-id>
claude-kimi-relay apply <task-id> --project .
```

`apply` runs `git apply --check` first, so a patch that would not apply cleanly never touches your project.

Foreground and background differ by entry point. The MCP `start_task` tool runs in the background by default, so Claude Code returns a task ID immediately and you poll with `get_task`. The `claude-kimi-relay start` CLI runs in the foreground and blocks until the task finishes unless you pass `--background`.

## Task lifecycle

```text
queued
  → preparing_workspace
  → starting_agent
  → running
  → validating
  → completed

Terminal alternatives: failed, cancelled, timed_out
```

## Configuration

| Variable                                |                              Default | Purpose                               |
| --------------------------------------- | -----------------------------------: | ------------------------------------- |
| `KIMI_CLI_PATH`                         |                               `kimi` | Kimi Code executable                  |
| `CLAUDE_KIMI_RELAY_DATA_DIR`            | plugin data / `~/.claude-kimi-relay` | Persistent tasks and artifacts        |
| `CLAUDE_KIMI_RELAY_TIMEOUT_MS`          |                            `1800000` | Default task timeout                  |
| `CLAUDE_KIMI_RELAY_MAX_FILE_BYTES`      |                            `5242880` | Maximum copied/read/written file size |
| `CLAUDE_KIMI_RELAY_MAX_WORKSPACE_BYTES` |                         `2147483648` | Maximum snapshot size                 |
| `CLAUDE_KIMI_RELAY_MAX_RESULT_BYTES`    |                           `10485760` | Maximum streamed textual result       |

## Asking for a specific model or reasoning level

A single task can request one, on the CLI or through `start_task`:

```bash
claude-kimi-relay start --kind challenge --project . \
  --thinking-effort max \
  --prompt "Challenge the retry and rollback design"
```

The value is a lookup key, never something sent to the agent verbatim: it is matched against the models and levels the agent advertises for that session. Ask for something it does not offer and the task still runs at the agent's own default, with a warning naming what was available. That is deliberate — a review that ran on the default model and found a real defect is worth more than no review at all.

Order matters and the relay handles it: the model is set first, because choosing a model can rewrite the reasoning scale or remove it entirely. Ask for `--model` with no reasoning support plus `--thinking-effort max` and you will get the model, a warning about the effort, and a result that reports what actually ran.

The skills pass these through only when you name a model or level yourself. They will not infer one from your repository, which matters because a repository under review is not a neutral party about how it gets reviewed.

## Which model answered

A completed task reports what produced it, under `result.agentConfig`:

```json
{
  "summary": "Model=kimi-code/k3, Thinking=high, Mode=default",
  "agent": { "name": "Kimi Code CLI", "version": "0.29.0" },
  "options": [
    { "id": "model", "name": "Model", "currentValue": "kimi-code/k3", "category": "model" }
  ]
}
```

This matters when you are using Kimi as a second opinion. A review from a large model reasoning hard and one from a small model with thinking off are not interchangeable evidence, and until now the two were indistinguishable.

Note what is not there: a `model` field. The relay does not know which of an agent's options is "the model" — it reports the agent's own option ids, names, and current values, and lets you draw that conclusion. An agent that advertises no configuration reports no options rather than a guessed one. If the agent changes model or reasoning level mid-run, `changedDuringRun` is set and the final values are the ones reported.

`envOverrides` lists the names — never the values — of the environment variables described below that were in effect. If a task ignored what you asked for, that list is the first place to look.

## Pointing Kimi at a different model

The relay does not own the model choice, and it deliberately adds no variable of its own for it. Kimi already has a documented channel, and the relay forwards it: the environment allowlist passes every `KIMI_*` and `MOONSHOT_*` variable through to `kimi acp` untouched.

So a persistent default belongs in Kimi's own configuration — `default_model` and `[thinking] effort` in `~/.kimi-code/config.toml` — or in Kimi's environment family, where `KIMI_MODEL_NAME` plus `KIMI_MODEL_API_KEY` synthesize a provider that overrides that default, and `KIMI_MODEL_THINKING_EFFORT` forces a reasoning level. Kimi's documentation is the authority on precedence between them.

The consequence worth knowing: whatever environment Claude Code launched the plugin's MCP server in is the environment every relayed task inherits. If a task behaves unexpectedly, check those variables before suspecting the relay.

## Local development

```bash
npm install
npm run verify
npm run build:plugin
claude --plugin-dir ./plugin
```

## Repository layout

```text
src/                         npm runtime and CLI
plugin/                      Claude Code plugin
  .claude-plugin/plugin.json
  .mcp.json
  skills/
  dist/                      generated self-contained MCP/worker bundle
.claude-plugin/marketplace.json
tests/
scripts/
.github/workflows/
```

## Interfaces this builds on

The Claude Code plugin manifest, skills, marketplace, and plugin-provided MCP server formats. The Model Context Protocol TypeScript SDK v1 over stdio. Kimi Code's documented `kimi acp` subprocess entry point, spoken through the Agent Client Protocol TypeScript SDK v1. Node child processes with argument arrays and `shell: false`. npm Trusted Publishing through GitHub Actions OIDC.

MCP v2 beta and the experimental ACP methods are deliberately left alone.

## What has actually been verified

`npm run verify` runs Prettier, ESLint (strict type-checked plus `eslint-plugin-security`, zero warnings allowed), `tsc --noEmit` under strict settings, the test suite, and a clean build of both the npm output and the plugin bundle.

The tests cover the places where a mistake would be expensive: lexical path traversal, symlink escape, secret-path blocking, writes through a symlinked workspace root, permission decisions for reads, writes, publishing, network tools, dependency installation and commits, atomic persistence under concurrent updates, removal of the original Git history, and the guarantee that a delegate patch carries only Kimi's changes.

Last end-to-end run: macOS arm64, Node 22.16, Git 2.50, Kimi Code 0.29.0. A review task moved through the full lifecycle and returned a correct result without modifying a single file, and the isolated workspace contained neither the original Git history nor the repository's `.env`. Details in [VALIDATION.md](./VALIDATION.md).

CI runs the same pipeline on Ubuntu, macOS, and Windows against Node 22 and 24.

## Before tagging a release

1. Confirm the npm package name and the marketplace name are still available.
2. Run `npm install` and commit the resulting `package-lock.json`.
3. Run `npm run verify` on Node 22 and 24.
4. Run `npm run build:plugin` and `node scripts/check-plugin-bundle.mjs`, then commit `plugin/dist`.
5. Run `claude plugin validate ./plugin --strict` and `claude plugin validate . --strict`.
6. Configure npm Trusted Publishing for `.github/workflows/release.yml`.
7. Run `npm run release:check`.
8. Do a live authenticated Kimi ACP run.
9. Tag `vX.Y.Z` and check npm provenance once it publishes.

## Contributing

Bug reports, patches, and threat-model challenges are all welcome. Open an issue for anything security-related through GitHub private vulnerability reporting rather than a public issue (see [SECURITY.md](./SECURITY.md)).

For code:

```bash
git clone https://github.com/YonasValentin/claude-kimi-relay
cd claude-kimi-relay
npm ci
npm run verify   # Prettier, ESLint, strict tsc, tests, and both builds
```

A few conventions that keep review short:

- Use Node.js 22 or 24, the versions CI runs.
- Keep changes focused and add a test for anything with logic. `npm run verify` has to pass on Node 22 and 24.
- Do not weaken path containment, the command policy, environment filtering, or isolated-workspace behaviour without updating [THREAT_MODEL.md](./THREAT_MODEL.md) in the same change.
- Formatting is enforced, not debated. Prettier decides.

Full detail in [CONTRIBUTING.md](./CONTRIBUTING.md). Contributions are licensed under Apache-2.0.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
