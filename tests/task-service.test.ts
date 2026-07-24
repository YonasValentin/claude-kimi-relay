import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { TaskService } from "../src/task-service.js";
import type { RelayConfig } from "../src/types.js";

const config = (dataDir: string): RelayConfig => ({
  dataDir,
  kimiCliPath: "kimi",
  defaultTimeoutMs: 60_000,
  maxFileBytes: 1024 * 1024,
  maxWorkspaceBytes: 10 * 1024 * 1024,
  maxResultBytes: 1024 * 1024,
});

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
