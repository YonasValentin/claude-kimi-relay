#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { RelayError } from "./errors.js";
import { TaskService } from "./task-service.js";
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
        .describe("Run detached and poll with get_task, or block until the task finishes."),
      baseRef: z
        .string()
        .default("HEAD")
        .describe("Git revision used as the comparison baseline for review and challenge tasks."),
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
    }),
  },
  async (input) =>
    text(
      taskSummary(
        await tasks.start({
          kind: input.kind,
          prompt: input.prompt,
          projectDir: resolveProjectDir(input.projectDir),
          background: input.background,
          baseRef: input.baseRef,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          keepWorkspace: input.keepWorkspace,
        }),
      ),
    ),
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

const transport = new StdioServerTransport();
await server.connect(transport);
