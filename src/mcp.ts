#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { RelayError } from "./errors.js";
import { TaskService, awaitTerminal } from "./task-service.js";
import type { TaskRecord } from "./types.js";
import { VERSION } from "./version.js";

const config = loadConfig();
const tasks = new TaskService(config);
const server = new McpServer({ name: "claude-kimi-relay", version: VERSION });

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function taskSummary(record: TaskRecord) {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    error: record.error,
    result: record.result,
    recentEvents: record.events.slice(-8),
  };
}

function resolveProjectDir(input: string | undefined): string {
  const trimmed = input?.trim();
  const projectDir = trimmed === undefined || trimmed === "" ? config.projectDir : trimmed;
  if (projectDir === undefined) {
    throw new RelayError(
      "No project directory was supplied. Restart Claude Code so CLAUDE_PROJECT_DIR is passed to the plugin MCP server.",
      "PROJECT_DIR_UNAVAILABLE",
    );
  }
  // The schema documents an absolute path; a relative one would otherwise be
  // resolved against the MCP server's cwd, which is not the user's project.
  if (!isAbsolute(projectDir)) {
    throw new RelayError("projectDir must be an absolute path.", "INVALID_PROJECT_DIR");
  }
  return projectDir;
}

server.registerTool(
  "start_task",
  {
    title: "Start a Kimi task",
    description:
      "Start a secure Kimi Code review, adversarial challenge, or isolated implementation task.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      kind: z
        .enum(["review", "challenge", "delegate"])
        .describe(
          "review: read-only analysis; challenge: adversarial design review; delegate: implementation in an isolated copy returned as a patch.",
        ),
      prompt: z.string().min(3).max(100_000).describe("Complete instruction for the Kimi agent."),
      projectDir: z
        .string()
        .min(1)
        .optional()
        .describe("Absolute project path. Defaults to the plugin's CLAUDE_PROJECT_DIR."),
      background: z
        .boolean()
        .default(true)
        .describe(
          "Return the task id immediately, or block until the task finishes and return its result. The task itself always runs in a detached worker, so it survives a client restart either way; blocking only decides whether this call waits for it.",
        ),
      baseRef: z
        .string()
        .optional()
        .describe(
          "Git revision used as the comparison baseline for review and challenge tasks. Omit to auto-select the merge-base with the branch's upstream.",
        ),
      timeoutMs: z
        .number()
        .int()
        .min(10_000)
        .max(86_400_000)
        .optional()
        .describe("Task timeout in milliseconds (10 seconds to 24 hours)."),
      keepWorkspace: z
        .boolean()
        .default(false)
        .describe("Keep the isolated workspace after completion for manual inspection."),
      model: z
        .string()
        .max(200)
        .optional()
        .describe(
          "Optional model to request from the agent, matched against the models it advertises for the session. Pass this only when the user named a model; do not guess one. Ignored with a warning if the agent does not offer it, and the result always reports what actually ran.",
        ),
      thinkingEffort: z
        .string()
        .max(200)
        .optional()
        .describe(
          "Optional reasoning effort to request (for example low, high, or max), matched against the levels the agent advertises. Pass this only when the user asked for one. Ignored with a warning if the agent does not offer it.",
        ),
    }),
  },
  async (input, extra) => {
    const started = await tasks.start({
      kind: input.kind,
      prompt: input.prompt,
      projectDir: resolveProjectDir(input.projectDir),
      // Always detached, so a blocking call is still durable: the work outlives
      // this process, and an interrupted call leaves a task that get_task can
      // still report on rather than losing it.
      background: true,
      ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      keepWorkspace: input.keepWorkspace,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.thinkingEffort === undefined ? {} : { thinkingEffort: input.thinkingEffort }),
    });
    if (input.background) return text(taskSummary(started));

    const progressToken = extra._meta?.progressToken;
    const finished = await awaitTerminal(
      (id) => tasks.get(id),
      started.id,
      extra.signal,
      async (progress, message) => {
        if (progressToken === undefined) return;
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress, message },
        });
      },
    );
    return text(taskSummary(finished));
  },
);

server.registerTool(
  "get_task",
  {
    title: "Get a Kimi task",
    description: "Read the current status and result for a Kimi task.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ id: z.string().uuid().describe("Task ID returned by start_task.") }),
  },
  async ({ id }) => text(taskSummary(await tasks.get(id))),
);

server.registerTool(
  "list_tasks",
  {
    title: "List Kimi tasks",
    description: "List recent Kimi tasks for this plugin installation.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of recent tasks to return."),
    }),
  },
  async ({ limit }) => text((await tasks.list(limit)).map(taskSummary)),
);

server.registerTool(
  "cancel_task",
  {
    title: "Cancel a Kimi task",
    description: "Cancel a queued or running background Kimi task.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ id: z.string().uuid().describe("Task ID returned by start_task.") }),
  },
  async ({ id }) => text(taskSummary(await tasks.cancel(id))),
);

server.registerTool(
  "doctor",
  {
    title: "Check Claude Kimi Relay",
    description: "Check Node.js, Git, Kimi Code, and the local state directory.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({}),
  },
  async () => text(await runDoctor(config)),
);

// Reconcile tasks orphaned by a previous server/worker that died mid-run before
// accepting new work, so a crashed run is not reported as running forever.
await tasks.reconcileOrphans().catch(() => undefined);

const transport = new StdioServerTransport();
await server.connect(transport);
