import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskStore } from "../src/store.js";
import type { TaskRecord } from "../src/types.js";

void test("TaskStore persists and atomically updates tasks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TaskStore(dir);
  const at = new Date().toISOString();
  const task: TaskRecord = {
    id: "123e4567-e89b-12d3-a456-426614174000",
    kind: "review",
    prompt: "Review",
    projectDir: "/tmp/project",
    baseRef: "HEAD",
    background: false,
    keepWorkspace: false,
    timeoutMs: 10_000,
    createdAt: at,
    updatedAt: at,
    status: "queued",
    events: [],
  };
  await store.create(task);
  assert.deepEqual(await store.get(task.id), task);
  await store.save({ ...task, status: "running" });
  assert.equal((await store.get(task.id)).status, "running");
});

void test("TaskStore serializes concurrent updates without losing events", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TaskStore(dir);
  const at = new Date().toISOString();
  const task: TaskRecord = {
    id: "223e4567-e89b-12d3-a456-426614174000",
    kind: "review",
    prompt: "Review",
    projectDir: "/tmp/project",
    baseRef: "HEAD",
    background: false,
    keepWorkspace: false,
    timeoutMs: 10_000,
    createdAt: at,
    updatedAt: at,
    status: "queued",
    events: [],
  };
  await store.create(task);
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.update(task.id, (current) => ({
        ...current,
        events: [...current.events, { at, status: "running", message: `event-${index}` }],
      })),
    ),
  );
  assert.equal((await store.get(task.id)).events.length, 20);
});
