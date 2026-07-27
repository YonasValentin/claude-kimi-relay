import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { runCommand } from "../src/process.js";
import { capEvents, MAX_EVENTS, TaskRunner } from "../src/runner.js";
import { TaskStore } from "../src/store.js";
import type { RelayConfig, TaskEvent, TaskRecord } from "../src/types.js";

void test("capEvents keeps the most recent events and a truncation marker when over the cap", () => {
  const many: TaskEvent[] = Array.from({ length: MAX_EVENTS + 50 }, (_, i) => ({
    at: `t${i}`,
    status: "running",
    message: `m${i}`,
  }));
  const capped = capEvents(many);
  assert.ok(capped.length <= MAX_EVENTS, `expected <= ${MAX_EVENTS}, got ${capped.length}`);
  assert.match(capped[0]?.message ?? "", /truncated/u);
  assert.equal(capped[capped.length - 1]?.message, `m${MAX_EVENTS + 49}`);
});

void test("capEvents leaves a short list untouched", () => {
  const few: TaskEvent[] = [{ at: "t0", status: "queued", message: "q" }];
  assert.deepEqual(capEvents(few), few);
});

const FAKE_AGENT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-acp-agent.mjs");

async function gitProject(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "relay-runner-repo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runCommand("git", ["init"], { cwd: root });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: root });
  await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await writeFile(join(root, "app.txt"), "committed\n");
  await runCommand("git", ["add", "app.txt"], { cwd: root });
  await runCommand("git", ["commit", "-m", "initial"], { cwd: root });
  return root;
}

void test("a failed task still records what produced it and what it was warned about", async (t) => {
  // The failure path wrote `error` and no result at all, so a timed-out review
  // reported neither the model that produced the silence nor the workspace
  // warnings gathered before the agent ever started -- including the loud
  // "there are no changes to review" one, which is often the actual cause.
  const projectDir = await gitProject(t);
  const dataDir = await mkdtemp(join(tmpdir(), "relay-runner-data-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  process.env.KIMI_TEST_SCENARIO = "silent";
  t.after(() => {
    delete process.env.KIMI_TEST_SCENARIO;
  });

  const config: RelayConfig = {
    dataDir,
    kimiCliPath: process.execPath,
    kimiCliArgs: [FAKE_AGENT],
    defaultTimeoutMs: 60_000,
    maxFileBytes: 65_536,
    maxWorkspaceBytes: 10_485_760,
    maxResultBytes: 1_048_576,
  };
  const at = new Date().toISOString();
  const store = new TaskStore(dataDir);
  const record: TaskRecord = {
    id: randomUUID(),
    kind: "review",
    prompt: "review the changes",
    projectDir,
    baseRef: "HEAD",
    background: false,
    keepWorkspace: false,
    // Below the request validator's floor on purpose: the fake agent never
    // answers, so the relay's own clock has to end the run.
    timeoutMs: 1_000,
    createdAt: at,
    updatedAt: at,
    status: "queued",
    events: [],
    thinkingEffort: "max",
  };
  await store.create(record);

  const finished = await new TaskRunner(config).run(record.id);

  const result = finished.result;

  assert.equal(finished.status, "timed_out");
  assert.match(finished.error ?? "", /timed out/iu);
  assert.ok(result, "a failed task must still carry provenance and warnings");
  assert.equal(result.summary, undefined, "a failed run has no summary to report");
  const agentConfig = result.agentConfig;
  assert.ok(agentConfig, "the agent's identity must survive the throw");
  assert.equal(agentConfig.summary, "Model=fake/large, Thinking=max");
  assert.deepEqual(agentConfig.agent, { name: "Fake ACP Agent", version: "1.2.3" });
  // baseRef HEAD against an unchanged tree: the warning that explains an empty
  // review, previously discarded along with everything else.
  assert.match(result.warnings.join("\n"), /NO changes to review/u);
});
