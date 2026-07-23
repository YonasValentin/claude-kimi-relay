import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { RelayError } from "./errors.js";
import type { TaskRecord } from "./types.js";

const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TaskStore {
  public constructor(private readonly dataDir: string) {}

  private get tasksDir(): string {
    return join(this.dataDir, "tasks");
  }

  public taskPath(id: string): string {
    // Case-insensitive to match the MCP layer's zod .uuid(), which accepts
    // uppercase-hex UUIDs; the store rejected them, an unnecessary asymmetry.
    if (!/^[a-f0-9-]{36}$/iu.test(id)) {
      throw new RelayError("Invalid task ID.", "INVALID_TASK_ID");
    }
    return join(this.tasksDir, `${id}.json`);
  }

  private lockPath(id: string): string {
    return join(this.tasksDir, `${id}.lock`);
  }

  public async initialize(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true, mode: 0o700 });
    await mkdir(join(this.dataDir, "workspaces"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.dataDir, "artifacts"), { recursive: true, mode: 0o700 });
  }

  private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const path = this.lockPath(id);
    // `${pid}:${uuid}`: the pid lets a waiter probe whether the holder is still
    // alive; the uuid is a fencing token so release only ever deletes the lock
    // this call created, never one a later holder acquired after a steal.
    const token = `${process.pid}:${randomUUID()}`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(token, "utf8");
        await handle.close().catch(() => undefined);
        try {
          return await operation();
        } finally {
          await this.releaseLock(path, token);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        if (await this.reclaimIfDead(path)) continue;
        if (Date.now() >= deadline) {
          throw new RelayError(`Timed out waiting for task ${id} lock.`, "TASK_LOCK_TIMEOUT", {
            cause: error,
          });
        }
        await sleep(20 + Math.floor(Math.random() * 30));
      }
    }
  }

  // Compare-and-delete: only remove the lock if it still carries our token. If
  // an over-long stall let another holder steal it, we must not delete theirs.
  private async releaseLock(path: string, token: string): Promise<void> {
    const current = await readFile(path, "utf8").catch(() => undefined);
    // Local lock fence in a file the process already owns, not a secret; a
    // constant-time comparison would buy nothing here.
    // eslint-disable-next-line security/detect-possible-timing-attacks
    if (current === token) await rm(path, { force: true }).catch(() => undefined);
  }

  // A stale lock is only reclaimed when its recorded holder is actually gone.
  // A live-but-slow holder keeps its lock, so a waiter fails loudly with a lock
  // timeout instead of stealing the lock and clobbering an in-flight update.
  private async reclaimIfDead(path: string): Promise<boolean> {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) return true; // vanished; retry the atomic create
    if (Date.now() - info.mtimeMs <= STALE_LOCK_MS) return false;
    if (await this.holderAlive(path)) return false;
    await rm(path, { force: true }).catch(() => undefined);
    return true;
  }

  private async holderAlive(path: string): Promise<boolean> {
    const raw = await readFile(path, "utf8").catch(() => "");
    const pid = Number.parseInt(raw.split(":")[0] ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 0) return false; // unknown holder -> treat as dead
    try {
      process.kill(pid, 0); // signal 0 probes existence without killing
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"; // exists under another user
    }
  }

  private async writeUnlocked(record: TaskRecord): Promise<void> {
    const path = this.taskPath(record.id);
    const tempPath = join(
      dirname(path),
      `.${record.id}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, path);
  }

  public async create(record: TaskRecord): Promise<void> {
    await this.initialize();
    const path = this.taskPath(record.id);
    try {
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      throw new RelayError(`Could not create task ${record.id}.`, "TASK_CREATE_FAILED", {
        cause: error,
      });
    }
  }

  public async get(id: string): Promise<TaskRecord> {
    try {
      const contents = await readFile(this.taskPath(id), "utf8");
      return JSON.parse(contents) as TaskRecord;
    } catch (error) {
      throw new RelayError(`Task ${id} was not found or is unreadable.`, "TASK_NOT_FOUND", {
        cause: error,
      });
    }
  }

  public async save(record: TaskRecord): Promise<void> {
    await this.withLock(record.id, () => this.writeUnlocked(record));
  }

  public async update(
    id: string,
    updater: (current: TaskRecord) => TaskRecord | Promise<TaskRecord>,
  ): Promise<TaskRecord> {
    return this.withLock(id, async () => {
      const current = await this.get(id);
      const next = await updater(current);
      if (next.id !== id)
        throw new RelayError("Task updater changed the task ID.", "INVALID_UPDATE");
      await this.writeUnlocked(next);
      return next;
    });
  }

  public async list(limit = 20): Promise<readonly TaskRecord[]> {
    await this.initialize();
    const names = (await readdir(this.tasksDir))
      .filter((name) => name.endsWith(".json"))
      .slice(0, 500);
    const records = await Promise.all(
      names.map(async (name) => {
        try {
          return JSON.parse(await readFile(join(this.tasksDir, name), "utf8")) as TaskRecord;
        } catch {
          return undefined;
        }
      }),
    );
    return records
      .filter((record): record is TaskRecord => record !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, Math.min(limit, 100)));
  }

  public async remove(id: string): Promise<void> {
    await this.withLock(id, () => rm(this.taskPath(id), { force: true }));
  }
}
