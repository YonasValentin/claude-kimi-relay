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
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`, "utf8");
        try {
          return await operation();
        } finally {
          await handle.close().catch(() => undefined);
          await rm(path, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        const info = await stat(path).catch(() => undefined);
        if (info !== undefined && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(path, { force: true }).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new RelayError(`Timed out waiting for task ${id} lock.`, "TASK_LOCK_TIMEOUT", {
            cause: error,
          });
        }
        await sleep(20 + Math.floor(Math.random() * 30));
      }
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
