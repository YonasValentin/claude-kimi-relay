import type { AgentRunResult, RelayConfig, TaskRecord, TaskStatus } from "./types.js";
import { KimiAcpClient } from "./acp-client.js";
import { RelayError, toErrorMessage } from "./errors.js";
import { startHeartbeat } from "./heartbeat.js";
import { buildPrompt } from "./prompts.js";
import { TaskStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const TERMINAL = new Set<TaskStatus>(["completed", "failed", "cancelled", "timed_out"]);

// While Kimi is running, emit a liveness event whenever this long without any
// progress update, so a poller can distinguish a slow-but-working run from a
// hung one.
const HEARTBEAT_INTERVAL_MS = 30_000;

function now(): string {
  return new Date().toISOString();
}

export class TaskRunner {
  private readonly store: TaskStore;
  private readonly workspace: WorkspaceManager;
  private readonly kimi: KimiAcpClient;

  public constructor(config: RelayConfig) {
    this.store = new TaskStore(config.dataDir);
    this.workspace = new WorkspaceManager(config);
    this.kimi = new KimiAcpClient(config);
  }

  private transition(id: string, status: TaskStatus, message: string): Promise<TaskRecord> {
    return this.store.update(id, (current) => {
      if (TERMINAL.has(current.status)) return current;
      const at = now();
      return {
        ...current,
        status,
        updatedAt: at,
        events: [...current.events, { at, status, message }],
      };
    });
  }

  public async run(id: string, signal?: AbortSignal): Promise<TaskRecord> {
    let record = await this.store.get(id);
    if (record.status !== "queued") return record;
    let preparedPath: string | undefined;
    let keepWorkspace = record.keepWorkspace;

    try {
      record = await this.transition(
        id,
        "preparing_workspace",
        "Creating isolated repository copy.",
      );
      if (TERMINAL.has(record.status)) return record;
      const prepared = await this.workspace.prepare(
        id,
        record.projectDir,
        record.kind,
        record.baseRef,
      );
      preparedPath = prepared.path;
      keepWorkspace = record.keepWorkspace;
      record = await this.store.update(id, (current) =>
        TERMINAL.has(current.status)
          ? current
          : { ...current, workspaceDir: prepared.path, updatedAt: now() },
      );
      if (TERMINAL.has(record.status)) return record;

      record = await this.transition(id, "starting_agent", "Starting Kimi through ACP.");
      if (TERMINAL.has(record.status)) return record;
      record = await this.transition(id, "running", "Kimi is working in the isolated workspace.");
      if (TERMINAL.has(record.status)) return record;

      let progressCount = 0;
      const heartbeat = startHeartbeat({
        intervalMs: HEARTBEAT_INTERVAL_MS,
        onBeat: (elapsedMs) => {
          void this.transition(
            id,
            "running",
            `Still analyzing — ${progressCount} update${progressCount === 1 ? "" : "s"} so far, ${Math.round(elapsedMs / 1000)}s elapsed.`,
          ).catch(() => undefined);
        },
      });
      let agentResult: AgentRunResult;
      try {
        agentResult = await this.kimi.run(
          {
            taskId: id,
            kind: record.kind,
            prompt: buildPrompt(record.kind, record.prompt, prepared.diffIsEmpty),
            workspaceDir: prepared.path,
            timeoutMs: record.timeoutMs,
          },
          async (message) => {
            progressCount += 1;
            heartbeat.recordActivity();
            await this.transition(id, "running", message);
          },
          signal,
        );
      } finally {
        heartbeat.stop();
      }

      record = await this.transition(
        id,
        "validating",
        "Collecting the result and generated patch.",
      );
      if (TERMINAL.has(record.status)) return record;
      const patchPath =
        record.kind === "delegate"
          ? await this.workspace.createPatch(id, prepared.path)
          : undefined;
      const completedAt = now();
      const completed = await this.store.update(id, (current) => {
        if (TERMINAL.has(current.status)) return current;
        return {
          ...current,
          status: "completed",
          updatedAt: completedAt,
          sessionId: agentResult.sessionId,
          result: {
            summary: agentResult.text || "Kimi returned no textual result.",
            stopReason: agentResult.stopReason,
            sessionId: agentResult.sessionId,
            ...(patchPath === undefined ? {} : { patchPath }),
            ...(record.keepWorkspace ? { workspacePath: prepared.path } : {}),
            warnings: [...prepared.warnings, ...agentResult.warnings],
          },
          events: [
            ...current.events,
            { at: completedAt, status: "completed", message: "Task completed." },
          ],
        };
      });
      return completed;
    } catch (error) {
      const errorCode = error instanceof RelayError ? error.code : "UNKNOWN";
      const status: TaskStatus =
        errorCode === "CANCELLED" ? "cancelled" : errorCode === "TIMEOUT" ? "timed_out" : "failed";
      const failedAt = now();
      const failed = await this.store.update(id, (current) =>
        TERMINAL.has(current.status)
          ? current
          : {
              ...current,
              status,
              updatedAt: failedAt,
              error: toErrorMessage(error),
              events: [...current.events, { at: failedAt, status, message: toErrorMessage(error) }],
            },
      );
      return failed;
    } finally {
      if (!keepWorkspace && preparedPath !== undefined) {
        await this.workspace.cleanup(preparedPath).catch(() => undefined);
      }
    }
  }
}
