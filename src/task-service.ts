import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RelayConfig, TaskKind, TaskRecord, TaskRequest, TaskStatus } from "./types.js";
import { RelayError, toErrorMessage } from "./errors.js";
import { TaskRunner } from "./runner.js";
import { TaskStore } from "./store.js";

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled", "timed_out"]);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 probes existence without killing
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists under another user
  }
}

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
  // Empty is the "auto" sentinel: the workspace resolves it to the upstream
  // merge-base for review/challenge, or the current tree for delegate. An
  // explicit ref (including "HEAD") is kept verbatim.
  const baseRef = trimmedBaseRef ?? "";
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
  // Foreground runs execute in this process rather than a detached worker, so
  // there is no pid to signal. Track their abort controllers so cancel() can
  // actually stop the in-flight Kimi run instead of only flipping the record.
  private readonly foreground = new Map<string, AbortController>();

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

    if (!input.background) {
      const controller = new AbortController();
      this.foreground.set(id, controller);
      try {
        return await this.runner.run(id, controller.signal);
      } finally {
        this.foreground.delete(id);
      }
    }

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

  // Reconcile tasks left in a non-terminal state by a process that has since
  // died (server restart, or a SIGKILL/OOM of a background worker that skipped
  // its terminal write). Without this they are reported as running forever. A
  // still-alive owner — e.g. a detached worker that outlived its parent server
  // — is left untouched, and queued tasks (not yet started, no owner) are left
  // for their worker to pick up. Call at server/CLI startup.
  // ponytail: liveness is a pid probe; a reused pid could look alive. The window
  // is a crash-to-next-startup gap and the fix is a pidfile/start-time token if
  // it ever matters.
  public async reconcileOrphans(): Promise<void> {
    const records = await this.store.list(100);
    await Promise.all(
      records.map(async (record) => {
        if (TERMINAL_STATUSES.has(record.status) || record.status === "queued") return;
        if (record.ownerPid !== undefined && isProcessAlive(record.ownerPid)) return;
        await this.markFailed(
          record.id,
          "Task owner process is no longer running; reconciled to failed after restart.",
        ).catch(() => undefined);
      }),
    );
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
    // Foreground run in this process: abort its Kimi session directly.
    this.foreground.get(id)?.abort();
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
