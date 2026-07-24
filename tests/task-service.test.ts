import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { TaskStore } from "../src/store.js";
import { TaskService } from "../src/task-service.js";
import type { RelayConfig, TaskRecord } from "../src/types.js";

const config = (dataDir: string): RelayConfig => ({
  dataDir,
  kimiCliPath: "kimi",
  defaultTimeoutMs: 60_000,
  maxFileBytes: 1024 * 1024,
  maxWorkspaceBytes: 10 * 1024 * 1024,
  maxResultBytes: 1024 * 1024,
});

function makeRecord(overrides: Partial<TaskRecord>): TaskRecord {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    id: randomUUID(),
    kind: "review",
    prompt: "review the changes",
    projectDir: "/tmp/project",
    baseRef: "",
    background: true,
    keepWorkspace: false,
    timeoutMs: 60_000,
    createdAt: at,
    updatedAt: at,
    status: "running",
    events: [{ at, status: "queued", message: "Task queued." }],
    ...overrides,
  };
}

void test("a background worker that fails to spawn marks the task failed instead of crashing", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "relay-svc-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskService(config(dataDir));

  // A non-existent project directory becomes the worker's cwd, so spawn emits
  // an asynchronous ENOENT 'error' event. Without a listener that would be an
  // uncaught exception; the task must instead transition to failed.
  const record = await service.start({
    kind: "review",
    prompt: "review the current changes",
    projectDir: join(dataDir, "does-not-exist"),
    background: true,
    baseRef: "HEAD",
    keepWorkspace: false,
  });

  const deadline = Date.now() + 5_000;
  let latest = await service.get(record.id);
  while (latest.status === "queued" && Date.now() < deadline) {
    await delay(50);
    latest = await service.get(record.id);
  }

  assert.equal(latest.status, "failed");
  assert.match(latest.error ?? "", /background worker/iu);
});

void test("a review with no explicit baseRef records the auto sentinel", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "relay-baseref-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskService(config(dataDir));

  const record = await service.start({
    kind: "review",
    prompt: "review the current changes",
    projectDir: join(dataDir, "does-not-exist"),
    background: true,
    keepWorkspace: false,
  });

  // Empty baseRef is the "auto" sentinel resolved later in the workspace; it is
  // not coerced to "HEAD" at request time for read-only kinds.
  assert.equal(record.baseRef, "");
});

void test("reconcileOrphans fails non-terminal tasks whose owner process is gone", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "relay-reap-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new TaskStore(dataDir);
  await store.initialize();

  const dead = makeRecord({ status: "running", ownerPid: 2_147_483_646 }); // no such pid
  const alive = makeRecord({ status: "running", ownerPid: process.pid });
  const queued = makeRecord({ status: "queued" }); // not started yet
  const done = makeRecord({ status: "completed" });
  for (const record of [dead, alive, queued, done]) await store.create(record);

  const service = new TaskService(config(dataDir));
  await service.reconcileOrphans();

  const reaped = await service.get(dead.id);
  assert.equal(reaped.status, "failed");
  assert.match(reaped.error ?? "", /no longer running|reconcil/iu);
  assert.equal((await service.get(alive.id)).status, "running"); // live owner untouched
  assert.equal((await service.get(queued.id)).status, "queued"); // never started, left alone
  assert.equal((await service.get(done.id)).status, "completed"); // terminal untouched
});

void test("reconcileOrphans fails a queued task whose spawned worker died before starting", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "relay-reap2-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new TaskStore(dataDir);
  await store.initialize();

  const queuedDeadWorker = makeRecord({ status: "queued", pid: 2_147_483_646 }); // spawned, worker gone
  const queuedNoOwner = makeRecord({ status: "queued" }); // foreground about to start in-process
  for (const record of [queuedDeadWorker, queuedNoOwner]) await store.create(record);

  const service = new TaskService(config(dataDir));
  await service.reconcileOrphans();

  assert.equal((await service.get(queuedDeadWorker.id)).status, "failed");
  assert.equal((await service.get(queuedNoOwner.id)).status, "queued"); // no owner yet, left alone
});
