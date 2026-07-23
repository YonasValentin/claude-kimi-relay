import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RelayConfig, TaskKind, TaskRecord, TaskRequest } from "./types.js";
import { RelayError, toErrorMessage } from "./errors.js";
import { TaskRunner } from "./runner.js";
import { TaskStore } from "./store.js";

interface ValidatedTaskRequest {
  readonly kind: TaskKind;
  readonly prompt: string;
  readonly projectDir: string;
  readonly background: boolean;
  readonly baseRef: string;
  readonly timeoutMs: number;
  readonly keepWorkspace: boolean;
}

function now(): string {
  return new Date().toISOString();
}

function validateRequest(request: TaskRequest, config: RelayConfig): ValidatedTaskRequest {
  const prompt = request.prompt.trim();
  if (prompt.length < 3) throw new RelayError("Task prompt is too short.", "INVALID_PROMPT");
  if (prompt.length > 100_000) throw new RelayError("Task prompt is too long.", "INVALID_PROMPT");
  if (!(["review", "challenge", "delegate"] as const).includes(request.kind)) {
    throw new RelayError("Unknown task kind.", "INVALID_TASK_KIND");
  }

  const trimmedBaseRef = request.baseRef?.trim();
  const baseRef = trimmedBaseRef === undefined || trimmedBaseRef === "" ? "HEAD" : trimmedBaseRef;
  if (baseRef.startsWith("-") || /[\0\r\n]/u.test(baseRef)) {
    throw new RelayError("baseRef is not a safe Git revision.", "INVALID_BASE_REF");
  }

  const timeoutMs = request.timeoutMs ?? config.defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 24 * 60 * 60 * 1000) {
    throw new RelayError("timeoutMs must be between 10 seconds and 24 hours.", "INVALID_TIMEOUT");
  }

  return {
    kind: request.kind,
    prompt,
    projectDir: resolve(request.projectDir),
    background: request.background ?? false,
    baseRef,
    timeoutMs,
    keepWorkspace: request.keepWorkspace ?? false,
  };
}

export class TaskService {
  private readonly store: TaskStore;
  private readonly runner: TaskRunner;

  public constructor(private readonly config: RelayConfig) {
    this.store = new TaskStore(config.dataDir);
    this.runner = new TaskRunner(config);
  }

  public async start(request: TaskRequest): Promise<TaskRecord> {
    const input = validateRequest(request, this.config);
    const id = randomUUID();
    const at = now();
    const record: TaskRecord = {
      id,
      kind: input.kind,
      prompt: input.prompt,
      projectDir: input.projectDir,
      baseRef: input.baseRef,
      background: input.background,
      keepWorkspace: input.keepWorkspace,
      timeoutMs: input.timeoutMs,
      createdAt: at,
      updatedAt: at,
      status: "queued",
      events: [{ at, status: "queued", message: "Task queued." }],
    };
    await this.store.create(record);

    if (!input.background) return this.runner.run(id);

    const currentFile = fileURLToPath(import.meta.url);
    const workerPath = join(dirname(currentFile), "worker.js");
    const child = spawn(process.execPath, [workerPath, "--task", id], {
      cwd: input.projectDir,
      env: { ...process.env, CLAUDE_KIMI_RELAY_DATA_DIR: this.config.dataDir },
      detached: process.platform !== "win32",
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    // A detached worker that fails to spawn (EMFILE / ENOMEM under memory
    // pressure, a missing cwd) emits 'error' asynchronously, after start() has
    // already returned. With no listener that becomes an uncaught exception and
    // takes down the long-lived MCP server, stranding every task. Record the
    // failure on the task instead of crashing the process.
    child.once("error", (error) => {
      void this.markFailed(id, `Could not start background worker: ${toErrorMessage(error)}`).catch(
        () => undefined,
      );
    });
    child.unref();
    return this.store.update(id, (current) => ({
      ...current,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      updatedAt: now(),
    }));
  }

  public get(id: string): Promise<TaskRecord> {
    return this.store.get(id);
  }

  public list(limit?: number): Promise<readonly TaskRecord[]> {
    return this.store.list(limit);
  }

  private markFailed(id: string, message: string): Promise<TaskRecord> {
    return this.store.update(id, (current) => {
      if (["completed", "failed", "cancelled", "timed_out"].includes(current.status)) {
        return current;
      }
      const at = now();
      return {
        ...current,
        status: "failed",
        updatedAt: at,
        error: message,
        events: [...current.events, { at, status: "failed", message }],
      };
    });
  }

  public async cancel(id: string): Promise<TaskRecord> {
    const record = await this.store.get(id);
    if (["completed", "failed", "cancelled", "timed_out"].includes(record.status)) return record;
    if (record.pid !== undefined) {
      try {
        process.kill(record.pid, "SIGTERM");
      } catch {
        // The process may have ended between reading the record and sending the signal.
      }
    }
    return this.store.update(id, (current) => {
      if (["completed", "failed", "cancelled", "timed_out"].includes(current.status))
        return current;
      const at = now();
      return {
        ...current,
        status: "cancelled",
        updatedAt: at,
        events: [
          ...current.events,
          { at, status: "cancelled", message: "Cancellation requested." },
        ],
      };
    });
  }
}
